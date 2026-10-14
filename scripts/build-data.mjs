// Turns every GPX file in tracks/ into data the site can render:
//   public/data/tracks.json          index of all tracks
//   public/data/<slug>.json          track geometry, stats and terrain metadata
//   public/data/<slug>.terrain.bin   Int16 heightmap (meters), row 0 = north
// Terrain comes from AWS Terrain Tiles (Terrarium encoding); downloads are cached in .cache/.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TRACKS_DIR = path.join(ROOT, 'tracks');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const CACHE_DIR = path.join(ROOT, '.cache', 'terrarium');
const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const EARTH_R = 6378137;
const GRID = 512; // samples along the longer side of the terrain
const MAX_TILES = 48;
const MAX_TRACK_POINTS = 2500;

const toRad = (d) => (d * Math.PI) / 180;
const mercX = (lon) => EARTH_R * toRad(lon);
const mercY = (lat) => EARTH_R * Math.log(Math.tan(Math.PI / 4 + toRad(lat) / 2));

function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

export function slugify(s) {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'track';
}

const text = (el, tag) => el.getElementsByTagName(tag)[0]?.textContent?.trim() || '';

export function parseGpx(xml, fallbackName) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const tracks = [];
  const trks = Array.from(doc.getElementsByTagName('trk'));
  for (const trk of trks) {
    const points = [];
    for (const pt of Array.from(trk.getElementsByTagName('trkpt'))) {
      const lat = parseFloat(pt.getAttribute('lat'));
      const lon = parseFloat(pt.getAttribute('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const ele = parseFloat(text(pt, 'ele'));
      const time = text(pt, 'time');
      points.push({ lat, lon, ele: validEle(ele), time: time ? Date.parse(time) : null });
    }
    if (points.length < 2) continue;
    tracks.push({ name: text(trk, 'name') || fallbackName, desc: text(trk, 'desc'), points });
  }
  // Some exports store a single route instead of a track.
  if (!tracks.length) {
    for (const rte of Array.from(doc.getElementsByTagName('rte'))) {
      const points = Array.from(rte.getElementsByTagName('rtept')).map((pt) => ({
        lat: parseFloat(pt.getAttribute('lat')),
        lon: parseFloat(pt.getAttribute('lon')),
        ele: validEle(parseFloat(text(pt, 'ele'))),
        time: null,
      }));
      if (points.length >= 2) tracks.push({ name: text(rte, 'name') || fallbackName, desc: text(rte, 'desc'), points });
    }
  }
  const waypoints = Array.from(doc.getElementsByTagName('wpt'))
    .map((pt) => ({
      lat: parseFloat(pt.getAttribute('lat')),
      lon: parseFloat(pt.getAttribute('lon')),
      name: text(pt, 'name'),
      sym: text(pt, 'sym'),
    }))
    .filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lon));
  return tracks.map((t) => ({ ...t, waypoints }));
}

// GPS units sometimes write sentinel values such as -19999 when they have no fix.
const validEle = (e) => (Number.isFinite(e) && e > -450 && e < 9000 ? e : null);

const TIME_ZONE = 'America/Los_Angeles';
export const localDate = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: TIME_ZONE });

// Gaia names recordings "Wednesday Morning Activity" after the day recording started;
// once a recording is split, rename each piece after its own start time.
function autoName(name, start) {
  if (!/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) (Morning|Afternoon|Evening|Night) /.test(name) || !start) return name;
  const d = new Date(start);
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: TIME_ZONE });
  const hour = Number(d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: false, timeZone: TIME_ZONE }));
  const part = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : hour < 21 ? 'Evening' : 'Night';
  return name.replace(/^\w+ \w+/, `${weekday} ${part}`);
}

/**
 * A recording left running for a whole trip mixes drives with the actual rides or hikes.
 * Split at long pauses, cut out stretches driven at highway speed, and keep the pieces
 * that look like a human-powered outing.
 */
export function splitActivities(trk) {
  const pts = trk.points;
  if (!pts[0].time || !pts[pts.length - 1].time) return [trk];
  const n = pts.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
  // Average speed over a ten-minute window centered on each point.
  const driving = new Uint8Array(n);
  const HALF = 5 * 60 * 1000;
  for (let i = 0, a = 0, b = 0; i < n; i++) {
    while (pts[a].time < pts[i].time - HALF) a++;
    while (b < n - 1 && pts[b + 1].time <= pts[i].time + HALF) b++;
    const dt = (pts[b].time - pts[a].time) / 1000;
    if (dt > 120 && (cum[b] - cum[a]) / dt > 60 / 3.6) driving[i] = 1;
  }
  const pieces = [];
  let cur = [];
  const flush = () => {
    if (cur.length > 1) pieces.push(cur);
    cur = [];
  };
  for (let i = 0; i < n; i++) {
    if (driving[i] || (i > 0 && pts[i].time - pts[i - 1].time > 2 * 3600 * 1000)) flush();
    if (!driving[i]) cur.push(pts[i]);
  }
  flush();
  if (pieces.length === 1 && pieces[0].length === n) return [trk];
  const kept = pieces.filter((p) => {
    const s = computeStats(p);
    const { gain } = elevationGain(p.map((q) => q.ele).filter((e) => e != null));
    const speed = s.distance / Math.max(s.moving || s.elapsed || 1, 1);
    return s.distance > 3000 && speed < 30 / 3.6 && (gain > 100 || speed < 20 / 3.6);
  });
  return kept.map((points) => ({ ...trk, name: autoName(trk.name, points[0].time), points }));
}

function computeStats(points) {
  let distance = 0;
  let moving = 0;
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const d = haversine(points[i - 1], points[i]);
    distance += d;
    cum.push(distance);
    const a = points[i - 1].time;
    const b = points[i].time;
    if (a && b && b > a) {
      const dt = (b - a) / 1000;
      // Count a segment as moving when faster than a slow walk and not a long pause.
      if (d / dt > 0.5 && dt < 300) moving += dt;
    }
  }
  const start = points[0].time;
  const end = points[points.length - 1].time;
  return { distance, cum, moving: moving || null, elapsed: start && end ? (end - start) / 1000 : null, start };
}

// Elevation gain with a hysteresis threshold so GPS noise does not inflate climbing.
function elevationGain(elevs, threshold = 4) {
  let gain = 0;
  let loss = 0;
  let ref = elevs[0];
  for (const e of elevs) {
    if (e - ref >= threshold) { gain += e - ref; ref = e; }
    else if (ref - e >= threshold) { loss += ref - e; ref = e; }
  }
  return { gain, loss };
}

// Douglas-Peucker on local meters, used to keep the client payload small.
function simplify(pts, tolerance) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [ax, ay] = pts[s];
    const [bx, by] = pts[e];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2));
      const d = Math.hypot(pts[i][0] - (ax + t * dx), pts[i][1] - (ay + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

async function fetchTile(z, x, y) {
  const file = path.join(CACHE_DIR, `${z}`, `${x}`, `${y}.png`);
  let buf;
  try {
    buf = await fs.readFile(file);
  } catch {
    for (let attempt = 0; attempt < 4 && !buf; attempt++) {
      try {
        const res = await fetch(TILE_URL(z, x, y));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        if (attempt === 3) throw new Error(`terrain tile ${z}/${x}/${y}: ${err.message}`);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, buf);
  }
  const png = PNG.sync.read(buf);
  const h = new Float32Array(256 * 256);
  for (let i = 0; i < h.length; i++) {
    const o = i * 4;
    h[i] = png.data[o] * 256 + png.data[o + 1] + png.data[o + 2] / 256 - 32768;
  }
  return h;
}

// Builds a GRID-sized heightmap covering a Web Mercator bbox.
async function buildTerrain(bbox) {
  const world = 2 * Math.PI * EARTH_R;
  const tileAt = (z, mx, my) => [((mx + world / 2) / world) * 2 ** z, ((world / 2 - my) / world) * 2 ** z];
  let z = 14;
  for (; z > 5; z--) {
    const [x0, y0] = tileAt(z, bbox.minX, bbox.maxY);
    const [x1, y1] = tileAt(z, bbox.maxX, bbox.minY);
    const count = (Math.floor(x1) - Math.floor(x0) + 1) * (Math.floor(y1) - Math.floor(y0) + 1);
    // Stop once a tile pixel is about as coarse as a grid cell, or we would download too much.
    const pxPerGrid = ((x1 - x0) * 256) / GRID;
    if (count <= MAX_TILES && pxPerGrid <= 2.5) break;
    if (count <= MAX_TILES / 4) break;
  }
  const w = bbox.maxX - bbox.minX;
  const h = bbox.maxY - bbox.minY;
  const nx = w >= h ? GRID : Math.max(16, Math.round((GRID * w) / h));
  const ny = w >= h ? Math.max(16, Math.round((GRID * h) / w)) : GRID;
  const tiles = new Map();
  const getTile = async (tx, ty) => {
    const key = `${tx}/${ty}`;
    if (!tiles.has(key)) tiles.set(key, fetchTile(z, tx, ty));
    return tiles.get(key);
  };
  const sample = async (fx, fy) => {
    const px = fx * 256;
    const py = fy * 256;
    const read = async (X, Y) => {
      const tx = Math.floor(X / 256);
      const ty = Math.floor(Y / 256);
      const t = await getTile(tx, ty);
      return t[(Y - ty * 256) * 256 + (X - tx * 256)];
    };
    const X = Math.floor(px - 0.5);
    const Y = Math.floor(py - 0.5);
    const ax = px - 0.5 - X;
    const ay = py - 0.5 - Y;
    const [a, b, c, d] = await Promise.all([read(X, Y), read(X + 1, Y), read(X, Y + 1), read(X + 1, Y + 1)]);
    return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
  };
  const heights = new Int16Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const my = bbox.maxY - (j / (ny - 1)) * h;
    const row = [];
    for (let i = 0; i < nx; i++) {
      const mx = bbox.minX + (i / (nx - 1)) * w;
      const [fx, fy] = tileAt(z, mx, my);
      row.push(sample(fx, fy));
    }
    const vals = await Promise.all(row);
    for (let i = 0; i < nx; i++) heights[j * nx + i] = Math.round(Math.max(-500, vals[i]));
  }
  return { nx, ny, heights, zoom: z, tiles: tiles.size };
}

// Best-effort place name ("Portola, California") from OpenStreetMap Nominatim, cached on disk.
async function placeName(lat, lon) {
  const file = path.join(ROOT, '.cache', 'places.json');
  let cache = {};
  try { cache = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (key in cache) return cache[key];
  let name = null;
  try {
    await new Promise((r) => setTimeout(r, 1100)); // Nominatim allows one request per second
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=10`, {
      headers: { 'User-Agent': 'us-west-tracks site build (github.com/eboudrant)' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const a = (await res.json()).address || {};
      const local = a.city || a.town || a.village || a.hamlet || a.county;
      name = [local, a.state].filter(Boolean).join(', ') || null;
    }
  } catch {
    return null; // offline or blocked: try again on the next build
  }
  cache[key] = name;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(cache, null, 1));
  return name;
}

// Tiny normalized SVG path of the track for index cards.
function previewPath(pts) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const s = 100 / Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY, 1);
  const ox = (100 - (Math.max(...xs) - minX) * s) / 2;
  const oy = (100 - (Math.max(...ys) - minY) * s) / 2;
  let simple = pts;
  for (let tol = 5; simple.length > 120; tol *= 1.5) simple = simplify(pts, tol);
  return simple
    .map((p, i) => `${i ? 'L' : 'M'}${(ox + (p[0] - minX) * s).toFixed(1)} ${(100 - oy - (p[1] - minY) * s).toFixed(1)}`)
    .join('');
}

/**
 * Places where the recording sat still for a while: lunch stops and camps.
 * A stop is a run of points staying within STOP_RADIUS of where it began for MIN_STOP_SECONDS or more.
 */
const MIN_STOP_SECONDS = 5 * 60;
const STOP_RADIUS = 80; // meters

function findStops(points, cum, xy) {
  const stops = [];
  let i = 0;
  while (i < points.length - 1) {
    if (!points[i].time) return stops;
    let j = i;
    while (j + 1 < points.length && haversine(points[i], points[j + 1]) < STOP_RADIUS) j++;
    const seconds = (points[j].time - points[i].time) / 1000;
    if (seconds >= MIN_STOP_SECONDS) {
      const days = (a, b) => Math.round((Date.parse(localDate(b)) - Date.parse(localDate(a))) / 86400000);
      stops.push({
        m: Math.round(cum[i]),
        x: Math.round(xy[i][0]),
        y: Math.round(xy[i][1]),
        start: new Date(points[i].time).toISOString(),
        end: new Date(points[j].time).toISOString(),
        nights: days(points[i].time, points[j].time),
      });
      i = j + 1;
    } else {
      i++;
    }
  }
  // A brief GPS jump can split one stop in two; join stops a couple of minutes apart.
  return stops.reduce((out, st) => {
    const prev = out[out.length - 1];
    if (prev && Date.parse(st.start) - Date.parse(prev.end) < 3 * 60 * 1000 && Math.hypot(st.x - prev.x, st.y - prev.y) < STOP_RADIUS * 2) {
      prev.end = st.end;
      prev.nights = Math.round((Date.parse(localDate(Date.parse(prev.end))) - Date.parse(localDate(Date.parse(prev.start)))) / 86400000);
    } else out.push(st);
    return out;
  }, []);
}

async function loadMeta() {
  try {
    return JSON.parse(await fs.readFile(path.join(TRACKS_DIR, 'meta.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function main() {
  // Start from an empty output folder so removed or renamed tracks do not linger.
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });
  const meta = await loadMeta();
  const files = (await fs.readdir(TRACKS_DIR)).filter((f) => f.toLowerCase().endsWith('.gpx')).sort();
  const index = [];
  const used = new Set();
  for (const file of files) {
    const xml = await fs.readFile(path.join(TRACKS_DIR, file), 'utf8');
    for (const trk of parseGpx(xml, path.basename(file, path.extname(file)))) {
      const stats = computeStats(trk.points);
      const day = stats.start ? localDate(stats.start) : null;
      let slug = slugify(trk.name);
      if (used.has(slug) && day) slug = `${slug}-${day}`;
      for (let n = 2; used.has(slug); n++) slug = `${slugify(trk.name)}-${n}`;
      used.add(slug);
      const m = meta[slug] || {};
      if (m.hidden) continue;

      const lats = trk.points.map((p) => p.lat);
      const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
      const k = Math.cos(toRad(lat0)); // mercator meters -> ground meters at this latitude
      const mx = trk.points.map((p) => mercX(p.lon));
      const my = trk.points.map((p) => mercY(p.lat));
      let bbox = { minX: Math.min(...mx), maxX: Math.max(...mx), minY: Math.min(...my), maxY: Math.max(...my) };
      // Pad around the track and make the terrain at least 3 km across.
      const span = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY, 3000 / k);
      const pad = span * 0.22;
      const cx = (bbox.minX + bbox.maxX) / 2;
      const cy = (bbox.minY + bbox.maxY) / 2;
      const halfW = Math.max((bbox.maxX - bbox.minX) / 2 + pad, span * 0.35);
      const halfH = Math.max((bbox.maxY - bbox.minY) / 2 + pad, span * 0.35);
      bbox = { minX: cx - halfW, maxX: cx + halfW, minY: cy - halfH, maxY: cy + halfH };

      process.stdout.write(`${slug}: ${trk.points.length} pts, ${(stats.distance / 1000).toFixed(1)} km … `);
      const terrain = await buildTerrain(bbox);

      // Elevation: prefer recorded values, fall back to terrain when the GPX has none.
      const terrainAt = (x, y) => {
        const fx = ((x - bbox.minX) / (bbox.maxX - bbox.minX)) * (terrain.nx - 1);
        const fy = ((bbox.maxY - y) / (bbox.maxY - bbox.minY)) * (terrain.ny - 1);
        const i = Math.max(0, Math.min(terrain.nx - 2, Math.floor(fx)));
        const j = Math.max(0, Math.min(terrain.ny - 2, Math.floor(fy)));
        const ax = fx - i;
        const ay = fy - j;
        const H = terrain.heights;
        const n = terrain.nx;
        return (H[j * n + i] * (1 - ax) + H[j * n + i + 1] * ax) * (1 - ay) + (H[(j + 1) * n + i] * (1 - ax) + H[(j + 1) * n + i + 1] * ax) * ay;
      };
      const hasEle = trk.points.filter((p) => p.ele != null).length > trk.points.length * 0.8;
      const elevs = trk.points.map((p, i) => (hasEle && p.ele != null ? p.ele : terrainAt(mx[i], my[i])));
      const { gain, loss } = elevationGain(elevs);

      // Local ground meters relative to the terrain center: x = east, y = north.
      let pts = trk.points.map((p, i) => [
        (mx[i] - cx) * k,
        (my[i] - cy) * k,
        elevs[i],
        stats.cum[i],
        p.time ? (p.time - (stats.start || 0)) / 1000 : null,
      ]);
      for (let tol = 1; pts.length > MAX_TRACK_POINTS; tol *= 1.6) pts = simplify(pts, tol);
      const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
      pts = pts.map(([x, y, e, d, t]) => [round(x, 1), round(y, 1), round(e, 1), round(d, 1), round(t, 0)]);

      const center = { lat: (180 / Math.PI) * (2 * Math.atan(Math.exp(cy / EARTH_R)) - Math.PI / 2), lon: (180 / Math.PI) * (cx / EARTH_R) };
      const record = {
        slug,
        name: m.title || trk.name,
        subtitle: m.subtitle || null,
        summary: m.summary || trk.desc || null,
        location: m.location || (await placeName(center.lat, center.lon)),
        link: m.link || null,
        // Planned routes (drawn in Gaia, not recorded) carry no per-point times.
        planned: !stats.start,
        date: day,
        endDate: stats.start && stats.elapsed ? localDate(stats.start + stats.elapsed * 1000) : null,
        start: stats.start ? new Date(stats.start).toISOString() : null,
        center,
        stats: {
          distance: stats.distance,
          gain,
          loss,
          moving: stats.moving,
          elapsed: stats.elapsed,
          minEle: Math.min(...elevs),
          maxEle: Math.max(...elevs),
        },
        preview: previewPath(pts),
      };
      const inside = (x, y) => x > bbox.minX && x < bbox.maxX && y > bbox.minY && y < bbox.maxY;
      const waypoints = trk.waypoints
        .filter((w) => inside(mercX(w.lon), mercY(w.lat)))
        .map((w) => ({ x: Math.round((mercX(w.lon) - cx) * k), y: Math.round((mercY(w.lat) - cy) * k), name: w.name, sym: w.sym }));
      const terrainMeta = {
        nx: terrain.nx,
        ny: terrain.ny,
        width: (bbox.maxX - bbox.minX) * k,
        height: (bbox.maxY - bbox.minY) * k,
        zoom: terrain.zoom,
        file: `${slug}.terrain.bin`,
        mercator: bbox,
      };
      await fs.writeFile(path.join(OUT_DIR, `${slug}.terrain.bin`), Buffer.from(terrain.heights.buffer));
      const stops = findStops(
        trk.points,
        stats.cum,
        trk.points.map((_, i) => [(mx[i] - cx) * k, (my[i] - cy) * k]),
      );
      await fs.writeFile(path.join(OUT_DIR, `${slug}.json`), JSON.stringify({ ...record, terrain: terrainMeta, waypoints, stops, track: pts }));
      for (const st of stops) console.log(`  stop at ${(st.m / 1609.344).toFixed(1)} mi: ${st.start} → ${st.end} (${st.nights} night(s))`);
      index.push(record);
      console.log(`terrain z${terrain.zoom} ${terrain.nx}×${terrain.ny} from ${terrain.tiles} tiles`);
    }
  }
  index.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  await fs.writeFile(path.join(OUT_DIR, 'tracks.json'), JSON.stringify(index, null, 1));
  console.log(`${index.length} track(s) written to public/data/`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
