// Writes tracks/sample-loop.gpx, a synthetic loop used until real tracks are added.
import fs from 'node:fs/promises';
const c = { lat: 39.795, lon: -120.425 };
const pts = [];
const n = 600;
const t0 = Date.parse('2026-09-25T15:00:00Z');
for (let i = 0; i <= n; i++) {
  const a = (i / n) * Math.PI * 2;
  const r = 2200 + 500 * Math.sin(a * 3) + 180 * Math.sin(a * 11);
  const lat = c.lat + (r * Math.cos(a)) / 111320;
  const lon = c.lon + (r * Math.sin(a)) / (111320 * Math.cos((c.lat * Math.PI) / 180));
  const time = new Date(t0 + i * 12000).toISOString();
  pts.push(`<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><time>${time}</time></trkpt>`);
}
const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="us-west-tracks" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>Sample Loop</name><trkseg>
${pts.join('\n')}
</trkseg></trk></gpx>
`;
await fs.writeFile(new URL('../tracks/sample-loop.gpx', import.meta.url), gpx);
