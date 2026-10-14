import * as THREE from 'three';

export const EXAGGERATION = 1.7;

/** Heightmap in local meters. Row 0 is the north edge; x grows east. */
export class Heightmap {
  readonly min: number;
  readonly max: number;

  constructor(
    readonly nx: number,
    readonly ny: number,
    readonly width: number,
    readonly height: number,
    readonly data: Int16Array,
  ) {
    let min = Infinity;
    let max = -Infinity;
    for (const v of data) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    this.min = min;
    this.max = max;
  }

  /** Elevation in meters at local (east, north) meters, bilinear. */
  at(x: number, y: number) {
    const fx = THREE.MathUtils.clamp((x / this.width + 0.5) * (this.nx - 1), 0, this.nx - 1.001);
    const fy = THREE.MathUtils.clamp((0.5 - y / this.height) * (this.ny - 1), 0, this.ny - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const ax = fx - i;
    const ay = fy - j;
    const n = this.nx;
    const d = this.data;
    return (d[j * n + i] * (1 - ax) + d[j * n + i + 1] * ax) * (1 - ay) + (d[(j + 1) * n + i] * (1 - ax) + d[(j + 1) * n + i + 1] * ax) * ay;
  }

  /** Scene Y for an elevation. */
  y(ele: number) {
    return (ele - this.min) * EXAGGERATION;
  }
}

const terrainVertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

// Plain shaded relief, shown while imagery loads or if it cannot be loaded.
const reliefFragment = /* glsl */ `
  uniform vec3 uSun;
  varying vec3 vNormal;
  void main() {
    float shade = 0.55 + 0.45 * max(dot(normalize(vNormal), normalize(uSun)), 0.0);
    gl_FragColor = vec4(vec3(0.74, 0.72, 0.68) * shade, 1.0);
  }
`;

const satelliteFragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uSun;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vec3 col = texture2D(uMap, vUv).rgb;
    // Imagery already carries its own shadows; add a light hillshade so relief still reads.
    float shade = 0.82 + 0.3 * max(dot(normalize(vNormal), normalize(uSun)), 0.0);
    gl_FragColor = vec4(col * shade, 1.0);
    #include <colorspace_fragment>
  }
`;

const skirtFragment = /* glsl */ `
  uniform float uBase;
  uniform float uTop;
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    float t = clamp((vWorld.y - uBase) / max(uTop - uBase, 1.0), 0.0, 1.0);
    vec3 col = mix(vec3(0.42, 0.36, 0.30), vec3(0.60, 0.53, 0.45), t);
    col *= 0.95 - abs(normalize(vNormal).x) * 0.08;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function buildTerrain(hm: Heightmap) {
  const group = new THREE.Group();
  const geo = new THREE.PlaneGeometry(hm.width, hm.height, hm.nx - 1, hm.ny - 1);
  geo.rotateX(-Math.PI / 2); // plane +y (north) becomes -z
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let k = 0; k < pos.count; k++) pos.setY(k, hm.y(hm.data[k]));
  geo.computeVertexNormals();

  const relief = hm.y(hm.max);
  const scale = Math.max(hm.width, hm.height);
  const sun = new THREE.Vector3(-0.55, 0.75, -0.35);
  const terrainMat = new THREE.ShaderMaterial({
    vertexShader: terrainVertex,
    fragmentShader: reliefFragment,
    uniforms: { uSun: { value: sun } },
  });
  const mesh = new THREE.Mesh(geo, terrainMat);
  group.add(mesh);

  // Diorama block: walls from the terrain edge down to a flat base.
  const base = -Math.max(relief * 0.18, scale * 0.025);
  const verts: number[] = [];
  const edge = (pts: [number, number][]) => {
    for (let k = 0; k < pts.length - 1; k++) {
      const [x0, z0] = pts[k];
      const [x1, z1] = pts[k + 1];
      const y0 = hm.y(hm.at(x0, -z0));
      const y1 = hm.y(hm.at(x1, -z1));
      verts.push(x0, y0, z0, x0, base, z0, x1, base, z1, x0, y0, z0, x1, base, z1, x1, y1, z1);
    }
  };
  const W = hm.width / 2;
  const H = hm.height / 2;
  const line = (n: number, f: (t: number) => [number, number]) => Array.from({ length: n }, (_, i) => f(i / (n - 1)));
  edge(line(hm.nx, (t) => [-W + t * hm.width, H])); // south, facing +z
  edge(line(hm.ny, (t) => [W, H - t * hm.height])); // east
  edge(line(hm.nx, (t) => [W - t * hm.width, -H])); // north
  edge(line(hm.ny, (t) => [-W, -H + t * hm.height])); // west
  const skirtGeo = new THREE.BufferGeometry();
  skirtGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  skirtGeo.computeVertexNormals();
  const skirtMat = new THREE.ShaderMaterial({
    vertexShader: terrainVertex,
    fragmentShader: skirtFragment,
    uniforms: { uBase: { value: base }, uTop: { value: relief } },
    side: THREE.DoubleSide,
  });
  group.add(new THREE.Mesh(skirtGeo, skirtMat));

  const bottom = new THREE.Mesh(
    new THREE.PlaneGeometry(hm.width, hm.height).rotateX(Math.PI / 2).translate(0, base, 0),
    new THREE.MeshBasicMaterial({ color: 0x8f7a66 }),
  );
  group.add(bottom);

  // Soft contact shadow under the block.
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = shadowCanvas.height = 128;
  const ctx = shadowCanvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(64, 64, 10, 64, 64, 64);
  grad.addColorStop(0, 'rgba(70,50,30,0.35)');
  grad.addColorStop(1, 'rgba(70,50,30,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(hm.width * 1.5, hm.height * 1.5).rotateX(-Math.PI / 2).translate(scale * 0.04, base - 1, scale * 0.05),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false }),
  );
  group.add(shadow);

  const satellite = (map: THREE.Texture) =>
    new THREE.ShaderMaterial({
      vertexShader: terrainVertex,
      fragmentShader: satelliteFragment,
      uniforms: { uMap: { value: map }, uSun: { value: sun } },
    });

  return { group, base, relief, mesh, satellite };
}
