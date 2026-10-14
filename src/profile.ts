import { feet, miles } from './format';

type Pt = [number, number, number, number, number | null];

/** Elevation profile on a canvas; reports the hovered distance (meters) or null. */
export class Profile {
  private cursor: number | null = null;
  private readonly total: number;
  private readonly lo: number;
  private readonly hi: number;
  private readonly peak: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly track: Pt[],
    private readonly marks: { m: number; label: string }[],
    onHover: (m: number | null) => void,
  ) {
    this.total = track[track.length - 1][3];
    const eles = track.map((p) => p[2]);
    const min = Math.min(...eles);
    const max = Math.max(...eles);
    const pad = Math.max((max - min) * 0.12, 10);
    this.peak = max;
    this.lo = min - pad;
    this.hi = max + pad * 0.6;

    const toM = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * this.total;
    };
    let dragging = false;
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      onHover(toM(e));
    });
    canvas.addEventListener('pointermove', (e) => {
      if (dragging || e.pointerType === 'mouse') onHover(toM(e));
    });
    const end = () => {
      dragging = false;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointerleave', () => {
      if (!dragging) {
        this.cursor = null;
        this.draw();
        onHover(null);
      }
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setCursor(m: number | null) {
    this.cursor = m;
    this.draw();
  }

  private draw() {
    const c = this.canvas;
    const dpr = Math.min(devicePixelRatio, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
    if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const bottom = h - 14;
    const X = (m: number) => (m / this.total) * w;
    const Y = (e: number) => bottom - ((e - this.lo) / (this.hi - this.lo)) * (bottom - 4);

    ctx.beginPath();
    ctx.moveTo(0, bottom);
    for (const p of this.track) ctx.lineTo(X(p[3]), Y(p[2]));
    ctx.lineTo(w, bottom);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, bottom);
    g.addColorStop(0, 'rgba(181, 69, 47, 0.32)');
    g.addColorStop(1, 'rgba(181, 69, 47, 0.04)');
    ctx.fillStyle = g;
    ctx.fill();

    ctx.beginPath();
    this.track.forEach((p, i) => (i ? ctx.lineTo(X(p[3]), Y(p[2])) : ctx.moveTo(X(p[3]), Y(p[2]))));
    ctx.strokeStyle = '#b5452f';
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.fillStyle = '#6b6156';
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText('0 mi', 0, h);
    ctx.textAlign = 'right';
    ctx.fillText(`${miles(this.total).toFixed(1)} mi`, w, h);
    const peakAt = this.track.find((p) => p[2] === this.peak)!;
    ctx.textAlign = X(peakAt[3]) < 40 ? 'left' : X(peakAt[3]) > w - 40 ? 'right' : 'center';
    ctx.fillText(`${Math.round(feet(this.peak)).toLocaleString('en-US')} ft`, X(peakAt[3]), Math.max(12, Y(this.peak) - 3));

    // Stops and camps: a small flag at the top of the chart.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const mk of this.marks) {
      const x = X(mk.m);
      ctx.strokeStyle = 'rgba(47, 42, 36, 0.35)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 4);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#2f2a24';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + 4, 7);
      ctx.lineTo(x - 4, 7);
      ctx.closePath();
      ctx.fill();
    }
    ctx.textBaseline = 'bottom';

    if (this.cursor != null) {
      const x = X(this.cursor);
      const i = this.track.findIndex((p) => p[3] >= this.cursor!);
      const e = this.track[Math.max(0, i)][2];
      ctx.strokeStyle = 'rgba(47, 42, 36, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.fillStyle = '#b5452f';
      ctx.beginPath();
      ctx.arc(x, Y(e), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
