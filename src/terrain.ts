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

const noiseGlsl = /* glsl */ `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
`;

const terrainVertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const terrainFragment = /* glsl */ `
  uniform float uMinY;
  uniform float uMaxY;
  uniform float uScale;
  uniform float uContour;
  uniform vec3 uSun;
  varying vec3 vWorld;
  varying vec3 vNormal;
  ${noiseGlsl}

  vec3 palette(float t) {
    vec3 c0 = vec3(0.56, 0.66, 0.50); // valley sage
    vec3 c1 = vec3(0.66, 0.71, 0.49); // meadow
    vec3 c2 = vec3(0.80, 0.74, 0.52); // dry ochre
    vec3 c3 = vec3(0.79, 0.62, 0.50); // sienna ridges
    vec3 c4 = vec3(0.84, 0.81, 0.86); // lavender granite
    if (t < 0.25) return mix(c0, c1, t / 0.25);
    if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
    if (t < 0.78) return mix(c2, c3, (t - 0.5) / 0.28);
    return mix(c3, c4, (t - 0.78) / 0.22);
  }

  void main() {
    vec3 n = normalize(vNormal);
    vec2 p = vWorld.xz / uScale;
    // Pigment pools: low-frequency blotches shift the hue band and the value.
    float blot = fbm(p * 3.0);
    float grain = fbm(p * 40.0);
    float t = clamp((vWorld.y - uMinY) / max(uMaxY - uMinY, 1.0) + (blot - 0.5) * 0.18, 0.0, 1.0);
    vec3 col = palette(t);

    // Steep slopes pick up darker umber pigment.
    float slope = 1.0 - n.y;
    col = mix(col, vec3(0.55, 0.45, 0.38), smoothstep(0.25, 0.75, slope) * 0.45);

    // Soft light with cool violet shadows and warm highlights.
    float diff = dot(n, normalize(uSun));
    float light = smoothstep(-0.2, 0.9, diff);
    vec3 shadow = vec3(0.48, 0.45, 0.64);
    col = mix(col * shadow * 1.25, col * vec3(1.06, 1.02, 0.94), light);

    // Watercolor value variation and granulation.
    col *= 0.92 + blot * 0.14;
    col *= 0.96 + grain * 0.07;

    // Wet edge: pigment collects along noise isolines.
    float iso = abs(fract(blot * 6.0) - 0.5);
    col *= 1.0 - smoothstep(0.05, 0.0, iso) * 0.04;

    // Faint contour lines.
    float c = vWorld.y / uContour;
    float cw = fwidth(c);
    float line = 1.0 - smoothstep(0.0, cw * 1.2, abs(fract(c) - 0.5) - 0.5 + cw);
    col = mix(col, col * 0.82, line * 0.25);

    // Lift toward paper so the palette reads as wash, not paint.
    col = mix(col, vec3(0.965, 0.937, 0.878), 0.12);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const skirtFragment = /* glsl */ `
  uniform float uBase;
  uniform float uTop;
  uniform float uScale;
  varying vec3 vWorld;
  varying vec3 vNormal;
  ${noiseGlsl}
  void main() {
    float t = clamp((vWorld.y - uBase) / max(uTop - uBase, 1.0), 0.0, 1.0);
    float bands = fbm(vec2((vWorld.x + vWorld.z) / uScale * 4.0, vWorld.y / uScale * 30.0));
    vec3 deep = vec3(0.62, 0.52, 0.44);
    vec3 top = vec3(0.78, 0.68, 0.55);
    vec3 col = mix(deep, top, t) * (0.9 + bands * 0.18);
    float side = abs(normalize(vNormal).x) * 0.08;
    col *= 0.95 - side;
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
    fragmentShader: terrainFragment,
    uniforms: {
      uMinY: { value: 0 },
      uMaxY: { value: relief },
      uScale: { value: scale / 4 },
      uContour: { value: (hm.max - hm.min > 600 ? 100 : 40) * EXAGGERATION },
      uSun: { value: sun },
    },
    extensions: { derivatives: true } as never,
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
    uniforms: { uBase: { value: base }, uTop: { value: relief }, uScale: { value: scale } },
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

  return { group, base, relief };
}
