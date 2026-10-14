export interface TrackSummary {
  slug: string;
  name: string;
  subtitle: string | null;
  summary: string | null;
  location: string | null;
  link: string | null;
  date: string | null;
  endDate: string | null;
  start: string | null;
  center: { lat: number; lon: number };
  stats: {
    distance: number;
    gain: number;
    loss: number;
    moving: number | null;
    elapsed: number | null;
    minEle: number;
    maxEle: number;
  };
  preview: string;
}

export interface Stop {
  m: number;
  x: number;
  y: number;
  start: string;
  end: string;
  nights: number;
}

export interface TrackData extends TrackSummary {
  terrain: {
    nx: number;
    ny: number;
    width: number;
    height: number;
    zoom: number;
    file: string;
    mercator: { minX: number; maxX: number; minY: number; maxY: number };
  };
  waypoints: { x: number; y: number; name: string; sym: string }[];
  /** Places the recording sat still for 45+ minutes; nights > 0 means camp. */
  stops: Stop[];
  /** [east m, north m, elevation m, cumulative distance m, seconds since start | null] */
  track: [number, number, number, number, number | null][];
}

export const miles = (m: number) => m / 1609.344;
export const feet = (m: number) => m * 3.28084;

export function fmtMiles(m: number) {
  const v = miles(m);
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

export function fmtFeet(m: number) {
  return Math.round(feet(m)).toLocaleString('en-US');
}

export function fmtDuration(s: number | null) {
  if (!s) return '–';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

export function fmtDate(iso: string | null) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** "October 7 – 11, 2026" for multi-day tracks. */
export function fmtDateRange(start: string | null, end: string | null) {
  if (!start || !end || end === start) return fmtDate(start);
  const a = new Date(`${start}T12:00:00`);
  const b = new Date(`${end}T12:00:00`);
  const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  const left = a.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const right = sameMonth ? `${b.getDate()}, ${b.getFullYear()}` : b.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return `${left} – ${right}`;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const TIME_ZONE = 'America/Los_Angeles';

/** "Fri Oct 9, 10:42 AM" in Pacific time, the clock the photos were taken on. */
export function fmtClock(ms: number) {
  return new Date(ms).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TIME_ZONE,
  });
}

export function fmtStop(st: Stop) {
  if (st.nights > 0) return `Camp · ${st.nights} night${st.nights > 1 ? 's' : ''}`;
  const min = Math.round((Date.parse(st.end) - Date.parse(st.start)) / 60000);
  return `Stopped for ${min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}` : `${min} min`}`;
}
