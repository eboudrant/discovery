// Lakes and rivers from OpenStreetMap (Overpass API), rasterized into a mask the
// watercolor shader paints as water. Best effort: without network the map simply has no water.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

const EARTH_R = 6378137;
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const toLat = (my) => (180 / Math.PI) * (2 * Math.atan(Math.exp(my / EARTH_R)) - Math.PI / 2);
const toLon = (mx) => (180 / Math.PI) * (mx / EARTH_R);
const mercX = (lon) => EARTH_R * ((lon * Math.PI) / 180);
const mercY = (lat) => EARTH_R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

// Line widths in ground meters.
const WIDTH = { river: 30, canal: 12, stream: 7 };

async function overpass(bbox, cacheDir) {
  const s = toLat(bbox.minY).toFixed(5);
  const n = toLat(bbox.maxY).toFixed(5);
  const w = toLon(bbox.minX).toFixed(5);
  const e = toLon(bbox.maxX).toFixed(5);
  const area = `(${s},${w},${n},${e})`;
  // Streams get dense over a large area; keep only rivers there.
  const big = bbox.maxX - bbox.minX > 40000;
  const waterways = big ? 'river|canal' : 'river|canal|stream';
  const query = `[out:json][timeout:90];(
    way["natural"="water"]${area};relation["natural"="water"]${area};
    way["landuse"="reservoir"]${area};relation["landuse"="reservoir"]${area};
    way["waterway"~"^(${waterways})$"]${area};
  );out geom;`;
  const file = path.join(cacheDir, `${crypto.createHash('sha1').update(query).digest('hex')}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {}
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        headers: { 'User-Agent': 'us-west-tracks site build (github.com/eboudrant/discovery)' },
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(json));
      return json;
    } catch (err) {
      console.warn(`  water: ${new URL(url).host} failed (${err.message})`);
    }
  }
  return null;
}

/** Fills even-odd polygons and strokes lines into a w×h Uint8 mask over a mercator bbox. */
export function rasterize(elements, bbox, w, h, metersPerMerc) {
  const mask = new Uint8Array(w * h);
  const px = (lon) => ((mercX(lon) - bbox.minX) / (bbox.maxX - bbox.minX)) * w;
  const py = (lat) => ((bbox.maxY - mercY(lat)) / (bbox.maxY - bbox.minY)) * h;
  const mPerPx = ((bbox.maxX - bbox.minX) * metersPerMerc) / w;

  const fill = (rings) => {
    let y0 = h;
    let y1 = 0;
    for (const r of rings) for (const [, y] of r) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1)); y++) {
      const sy = y + 0.5;
      const xs = [];
      for (const r of rings) {
        for (let i = 0; i < r.length; i++) {
          const [ax, ay] = r[i];
          const [bx, by] = r[(i + 1) % r.length];
          if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.max(0, Math.ceil(xs[i] - 0.5)); x <= Math.min(w - 1, Math.floor(xs[i + 1] - 0.5)); x++) mask[y * w + x] = 255;
      }
    }
  };
  const stroke = (pts, widthM) => {
    const r = Math.max(0.9, widthM / mPerPx / 2);
    const dot = (cx, cy) => {
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
        if (y < 0 || y >= h) continue;
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          if (x < 0 || x >= w) continue;
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
          if (d <= r + 0.5) mask[y * w + x] = Math.max(mask[y * w + x], d <= r - 0.5 ? 255 : Math.round(255 * (r + 0.5 - d)));
        }
      }
    };
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(0.5, r * 0.7)));
      for (let k = 0; k <= steps; k++) dot(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps);
    }
  };
  const ring = (geom) => geom.map((g) => [px(g.lon), py(g.lat)]);

  let lakes = 0;
  let rivers = 0;
  for (const el of elements) {
    const t = el.tags || {};
    if (el.type === 'way' && t.waterway && el.geometry) {
      stroke(ring(el.geometry), WIDTH[t.waterway] ?? 6);
      rivers++;
    } else if (el.type === 'way' && el.geometry && el.geometry.length > 2) {
      fill([ring(el.geometry)]);
      lakes++;
    } else if (el.type === 'relation' && el.members) {
      // Outer and inner rings filled together with even-odd gives islands as holes.
      const rings = el.members.filter((m) => m.type === 'way' && m.geometry?.length > 1).map((m) => ring(m.geometry));
      if (rings.length) {
        fill(rings);
        lakes++;
      }
    }
  }
  return { mask, lakes, rivers };
}

export async function buildWaterMask(bbox, w, h, metersPerMerc, outFile, cacheDir) {
  const data = await overpass(bbox, cacheDir);
  if (!data?.elements) return null;
  const { mask, lakes, rivers } = rasterize(data.elements, bbox, w, h, metersPerMerc);
  if (!lakes && !rivers) return null;
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = mask[i];
    png.data[i * 4 + 3] = 255;
  }
  await fs.writeFile(outFile, PNG.sync.write(png));
  return { lakes, rivers };
}
