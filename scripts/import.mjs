// Usage: npm run import -- path/to/gaia-export.gpx [...]
//        npm run import -- export.gpx --from 39.5596,-120.8266 --to 39.3280,-120.1833 --name "Downieville to Truckee"
// Copies only the rides and hikes from a Gaia GPS export into tracks/, one GPX per outing.
// Drives (and with them the start and end at home) are left out, so the raw recording never
// has to be committed to this public repository.
// With --from/--to, keeps the whole stretch between the points closest to those places instead,
// drives included, as a single track (handy for a multi-day trip).
import fs from 'node:fs/promises';
import path from 'node:path';
import { localDate, parseGpx, slugify, splitActivities } from './build-data.mjs';

const TRACKS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'tracks');
const esc = (s) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const from = opt('from')?.split(',').map(Number);
const to = opt('to')?.split(',').map(Number);
const rename = opt('name');
const files = args;
const dist2 = (p, [lat, lon]) => (p.lat - lat) ** 2 + ((p.lon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
const closest = (pts, target, startAt = 0) => {
  let best = startAt;
  for (let i = startAt; i < pts.length; i++) if (dist2(pts[i], target) < dist2(pts[best], target)) best = i;
  return best;
};
function trim(trk) {
  const a = from ? closest(trk.points, from) : 0;
  const b = to ? closest(trk.points, to, a) : trk.points.length - 1;
  return [{ ...trk, name: rename || trk.name, points: trk.points.slice(a, b + 1) }];
}
if (!files.length) {
  console.error('Usage: npm run import -- <export.gpx> [...]');
  process.exit(1);
}
for (const file of files) {
  const xml = await fs.readFile(file, 'utf8');
  const tracks = parseGpx(xml, path.basename(file, path.extname(file)));
  for (const trk of tracks.flatMap(from || to ? trim : splitActivities)) {
    const lats = trk.points.map((p) => p.lat);
    const lons = trk.points.map((p) => p.lon);
    const pad = 0.02;
    const near = (w) =>
      w.lat > Math.min(...lats) - pad && w.lat < Math.max(...lats) + pad && w.lon > Math.min(...lons) - pad && w.lon < Math.max(...lons) + pad;
    const wpts = trk.waypoints
      .filter(near)
      .map((w) => `<wpt lat="${w.lat}" lon="${w.lon}"><name>${esc(w.name)}</name><sym>${esc(w.sym)}</sym></wpt>`);
    const pts = trk.points.map(
      (p) =>
        `<trkpt lat="${p.lat}" lon="${p.lon}">${p.ele != null ? `<ele>${p.ele}</ele>` : ''}${p.time ? `<time>${new Date(p.time).toISOString()}</time>` : ''}</trkpt>`,
    );
    const day = trk.points[0].time ? localDate(trk.points[0].time) : 'undated';
    const out = path.join(TRACKS_DIR, `${day}-${slugify(trk.name)}.gpx`);
    await fs.writeFile(
      out,
      `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="us-west-tracks import" xmlns="http://www.topografix.com/GPX/1/1">\n${wpts.join('\n')}\n<trk><name>${esc(trk.name)}</name><trkseg>\n${pts.join('\n')}\n</trkseg></trk>\n</gpx>\n`,
    );
    console.log(`${path.relative(process.cwd(), out)}  ${trk.points.length} points`);
  }
}
