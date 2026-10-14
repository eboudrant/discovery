// Usage: npm run import -- path/to/gaia-export.gpx [...]
// Copies only the rides and hikes from a Gaia GPS export into tracks/, one GPX per outing.
// Drives (and with them the start and end at home) are left out, so the raw recording never
// has to be committed to this public repository.
import fs from 'node:fs/promises';
import path from 'node:path';
import { localDate, parseGpx, slugify, splitActivities } from './build-data.mjs';

const TRACKS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'tracks');
const esc = (s) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: npm run import -- <export.gpx> [...]');
  process.exit(1);
}
for (const file of files) {
  const xml = await fs.readFile(file, 'utf8');
  for (const trk of parseGpx(xml, path.basename(file, path.extname(file))).flatMap(splitActivities)) {
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
