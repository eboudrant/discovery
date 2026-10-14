import * as THREE from 'three';

const WORLD = 2 * Math.PI * 6378137;
const TILE = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
export const SATELLITE_CREDIT = 'Imagery © Esri, Maxar, Earthstar Geographics';

export interface MercatorBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${url}`));
    img.src = url;
  });
}

/** Stitches Esri World Imagery tiles into one texture covering the terrain exactly. */
export async function loadSatellite(box: MercatorBox, renderer: THREE.WebGLRenderer) {
  const maxSize = Math.min(4096, renderer.capabilities.maxTextureSize);
  const tileAt = (z: number, mx: number, my: number) => [((mx + WORLD / 2) / WORLD) * 2 ** z, ((WORLD / 2 - my) / WORLD) * 2 ** z];
  let z = 17;
  for (; z > 3; z--) {
    const [x0, y0] = tileAt(z, box.minX, box.maxY);
    const [x1, y1] = tileAt(z, box.maxX, box.minY);
    const count = (Math.floor(x1) - Math.floor(x0) + 1) * (Math.floor(y1) - Math.floor(y0) + 1);
    if ((x1 - x0) * 256 <= maxSize && (y1 - y0) * 256 <= maxSize && count <= 144) break;
  }
  const [fx0, fy0] = tileAt(z, box.minX, box.maxY);
  const [fx1, fy1] = tileAt(z, box.maxX, box.minY);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round((fx1 - fx0) * 256);
  canvas.height = Math.round((fy1 - fy0) * 256);
  const ctx = canvas.getContext('2d')!;
  const jobs: Promise<void>[] = [];
  for (let ty = Math.floor(fy0); ty <= Math.floor(fy1); ty++) {
    for (let tx = Math.floor(fx0); tx <= Math.floor(fx1); tx++) {
      jobs.push(
        loadImage(TILE(z, tx, ty)).then((img) => {
          ctx.drawImage(img, Math.round((tx - fx0) * 256), Math.round((ty - fy0) * 256), 256, 256);
        }),
      );
    }
  }
  const results = await Promise.allSettled(jobs);
  if (results.every((r) => r.status === 'rejected')) throw new Error('Satellite imagery is unavailable');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}
