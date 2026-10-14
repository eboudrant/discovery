import './style.css';
import { escapeHtml, fmtDateRange, fmtDuration, fmtFeet, fmtMiles, type TrackSummary } from './format';

async function main() {
  const grid = document.getElementById('grid')!;
  const tracks: TrackSummary[] = await fetch('data/tracks.json').then((r) => r.json());
  if (!tracks.length) {
    grid.innerHTML = '<p class="empty">No tracks yet. Add GPX files to the tracks folder.</p>';
    return;
  }
  const total = tracks.reduce(
    (acc, t) => ({ d: acc.d + t.stats.distance, g: acc.g + t.stats.gain }),
    { d: 0, g: 0 },
  );
  document.getElementById('totals')!.innerHTML = `
    <span><b>${tracks.length}</b>tracks</span>
    <span><b>${fmtMiles(total.d)}</b>miles</span>
    <span><b>${fmtFeet(total.g)}</b>feet climbed</span>`;
  grid.innerHTML = tracks
    .map(
      (t) => `
      <a class="card" href="track.html?t=${encodeURIComponent(t.slug)}">
        <svg viewBox="-8 -8 116 116" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path d="${t.preview}"/></svg>
        <h2>${escapeHtml(t.name)}</h2>
        <p class="when">${[t.planned ? 'Planned route' : fmtDateRange(t.date, t.endDate), t.location].filter(Boolean).map((s) => escapeHtml(s!)).join(' · ')}</p>
        <div class="nums">
          <span><b>${fmtMiles(t.stats.distance)}</b> mi</span>
          <span><b>${fmtFeet(t.stats.gain)}</b> ft</span>
          ${t.planned ? '' : `<span><b>${fmtDuration(t.stats.moving ?? t.stats.elapsed)}</b></span>`}
        </div>
      </a>`,
    )
    .join('');
}

main().catch((err) => {
  console.error(err);
  document.getElementById('grid')!.innerHTML = '<p class="empty">Could not load tracks.</p>';
});
