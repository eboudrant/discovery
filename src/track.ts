import './style.css';
import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { escapeHtml, feet, fmtClock, fmtDateRange, fmtStop, type Stop, fmtDuration, fmtFeet, fmtMiles, miles, type TrackData } from './format';
import { Heightmap, buildTerrain } from './terrain';
import { Profile } from './profile';
import { SATELLITE_CREDIT, loadSatellite } from './satellite';

const ACCENT = 0xb5452f;

async function load(slug: string) {
  const data: TrackData = await fetch(`data/${encodeURIComponent(slug)}.json`).then((r) => {
    if (!r.ok) throw new Error(`Track "${slug}" not found`);
    return r.json();
  });
  const buf = await fetch(`data/${data.terrain.file}`).then((r) => r.arrayBuffer());
  const t = data.terrain;
  return { data, hm: new Heightmap(t.nx, t.ny, t.width, t.height, new Int16Array(buf)) };
}

function renderInfo(d: TrackData) {
  document.title = `${d.name} · 3D Trail Map`;
  const words = d.name.split(' ');
  const last = words.length > 1 ? words.pop()! : null;
  document.getElementById('title')!.innerHTML = last
    ? `${escapeHtml(words.join(' '))} <em>${escapeHtml(last)}</em>`
    : escapeHtml(d.name);
  document.getElementById('meta')!.textContent = [fmtDateRange(d.date, d.endDate), d.location].filter(Boolean).join(' · ');
  document.getElementById('summary')!.textContent = d.summary ?? '';
  const s = d.stats;
  document.getElementById('stats')!.innerHTML = `
    <div><dt>Distance</dt><dd>${fmtMiles(s.distance)}<small>mi</small></dd></div>
    <div><dt>Climbing</dt><dd>${fmtFeet(s.gain)}<small>ft</small></dd></div>
    <div><dt>${s.moving ? 'Moving' : 'Time'}</dt><dd>${fmtDuration(s.moving ?? s.elapsed)}</dd></div>`;
  if (d.link) {
    const a = document.getElementById('gpx-link') as HTMLAnchorElement;
    a.href = d.link;
    a.hidden = false;
  }
}

/** Track in scene coordinates, densified and draped on the terrain. */
function drape(d: TrackData, hm: Heightmap) {
  const step = Math.min(hm.width / hm.nx, hm.height / hm.ny);
  const lift = 5 * Math.max(1, hm.width / 8000);
  const pts: THREE.Vector3[] = [];
  const dist: number[] = [];
  const src = d.track;
  for (let i = 0; i < src.length; i++) {
    const [x, y, , m] = src[i];
    if (i > 0) {
      const [px, py, , pm] = src[i - 1];
      const segs = Math.ceil(Math.hypot(x - px, y - py) / step);
      for (let k = 1; k < segs; k++) {
        const t = k / segs;
        const ix = px + (x - px) * t;
        const iy = py + (y - py) * t;
        pts.push(new THREE.Vector3(ix, hm.y(hm.at(ix, iy)) + lift, -iy));
        dist.push(pm + (m - pm) * t);
      }
    }
    pts.push(new THREE.Vector3(x, hm.y(hm.at(x, y)) + lift, -y));
    dist.push(m);
  }
  return { pts, dist };
}

function pointAt(pts: THREE.Vector3[], dist: number[], m: number, out = new THREE.Vector3()) {
  let lo = 0;
  let hi = dist.length - 1;
  if (m <= dist[0]) return out.copy(pts[0]);
  if (m >= dist[hi]) return out.copy(pts[hi]);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] < m) lo = mid;
    else hi = mid;
  }
  const t = (m - dist[lo]) / Math.max(dist[hi] - dist[lo], 1e-6);
  return out.lerpVectors(pts[lo], pts[hi], t);
}

async function main() {
  const slug = new URLSearchParams(location.search).get('t');
  if (!slug) {
    location.replace('./');
    return;
  }
  const { data, hm } = await load(slug);
  renderInfo(data);

  const stage = document.getElementById('stage')!;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const size = Math.max(hm.width, hm.height);
  const camera = new THREE.PerspectiveCamera(32, 1, size / 500, size * 20);
  const terrain = buildTerrain(hm);
  const { group, relief } = terrain;
  scene.add(group);
  // Satellite imagery draped on the terrain; shaded relief stays if it cannot load.
  const imagery = loadSatellite(data.terrain.mercator, renderer)
    .then((tex) => {
      terrain.mesh.material = terrain.satellite(tex);
      document.getElementById('credit')!.textContent = SATELLITE_CREDIT;
    })
    .catch((err) => console.warn(err));

  // The track: a pale halo under a red ink line.
  const { pts, dist } = drape(data, hm);
  const flat = pts.flatMap((p) => [p.x, p.y, p.z]);
  const lineGeo = new LineGeometry();
  lineGeo.setPositions(flat);
  const halo = new Line2(lineGeo, new LineMaterial({ color: 0xfff8ea, linewidth: 7, transparent: true, opacity: 0.85, depthWrite: false }));
  const ink = new Line2(lineGeo, new LineMaterial({ color: ACCENT, linewidth: 3.2, transparent: true }));
  halo.renderOrder = 1;
  ink.renderOrder = 2;
  scene.add(halo, ink);
  const lineMats = [halo.material, ink.material];

  // Start and rider markers: constant on-screen size so they read at any zoom.
  const dot = (fill: string, px: number) => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.shadowColor = 'rgba(40,28,16,0.45)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(32, 32, 20, 0, Math.PI * 2);
    ctx.fillStyle = '#fff8ea';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(32, 32, 14, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, transparent: true }),
    );
    sprite.scale.setScalar(px / 1000);
    sprite.renderOrder = 5;
    return sprite;
  };
  const start = dot('#3f6b4a', 26);
  start.position.copy(pts[0]);
  scene.add(start);
  for (const w of data.waypoints ?? []) {
    const marker = dot(/camp/i.test(w.sym) ? '#5b6f8f' : '#2f2a24', 16);
    marker.position.set(w.x, hm.y(hm.at(w.x, w.y)) + size / 400, -w.y);
    scene.add(marker);
  }
  // Camps and stops, merged when they are at the same spot (several nights at one camp).
  const places: { x: number; y: number; nights: number; stops: Stop[] }[] = [];
  for (const st of data.stops ?? []) {
    const same = places.find((p) => Math.hypot(p.x - st.x, p.y - st.y) < 300);
    if (same) {
      same.nights += st.nights;
      same.stops.push(st);
    } else places.push({ x: st.x, y: st.y, nights: st.nights, stops: [st] });
  }
  const labelLayer = document.getElementById('labels')!;
  const labels = places.map((p) => {
    const pos = new THREE.Vector3(p.x, hm.y(hm.at(p.x, p.y)) + size / 400, -p.y);
    const marker = dot(p.nights ? '#2e5d3a' : '#6b6156', 20);
    marker.position.copy(pos);
    scene.add(marker);
    const el = document.createElement('div');
    el.className = 'map-label';
    el.textContent = p.nights ? `Camp · ${p.nights} night${p.nights > 1 ? 's' : ''}` : fmtStop(p.stops[0]);
    labelLayer.appendChild(el);
    return { pos, el };
  });
  const v = new THREE.Vector3();
  const placeLabels = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    for (const l of labels) {
      v.copy(l.pos).project(camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      l.el.style.display = visible ? '' : 'none';
      if (visible) l.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -150%)`;
    }
  };

  const rider = dot('#b5452f', 34);
  rider.renderOrder = 6;
  rider.visible = false;
  scene.add(rider);

  // Map-style controls: drag to pan, scroll/pinch to zoom toward the cursor,
  // right-drag or two-finger twist to rotate and tilt.
  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.zoomToCursor = true;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = size * 0.005;
  controls.maxDistance = size * 3;
  // Home view: three-quarter view from the south-southwest, framed on the track.
  const trackBox = new THREE.Box3().setFromPoints(pts);
  const homeTarget = trackBox.getCenter(new THREE.Vector3());
  const homeDir = new THREE.Vector3(-0.35, 0.82, 0.95).normalize();
  const trackSize = Math.max(trackBox.max.x - trackBox.min.x, trackBox.max.z - trackBox.min.z, size * 0.15);
  const homeView = () => {
    // Back off further on narrow (portrait) screens.
    const fit = (trackSize * 0.75) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.min(1, camera.aspect * 1.1);
    return { target: homeTarget.clone(), position: homeTarget.clone().addScaledVector(homeDir, fit) };
  };
  let flight: { from: { target: THREE.Vector3; position: THREE.Vector3 }; t0: number } | null = null;
  const resetView = (animate = false) => {
    if (animate) {
      flight = { from: { target: controls.target.clone(), position: camera.position.clone() }, t0: performance.now() };
      return;
    }
    const v = homeView();
    controls.target.copy(v.target);
    camera.position.copy(v.position);
  };
  document.getElementById('recenter')!.addEventListener('click', () => {
    if (playing) stopPlay();
    resetView(true);
  });

  const resize = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    // Leave room for the side panel on wide screens by shifting the view.
    const panel = innerWidth > 720 ? Math.min(420, w * 0.4) : 0;
    camera.setViewOffset(w, h, -panel / 2, 0, w, h);
    camera.updateProjectionMatrix();
    for (const m of lineMats) m.resolution.set(w, h);
  };
  addEventListener('resize', resize);
  resize();
  resetView();

  // Elevation profile <-> marker.
  const total = dist[dist.length - 1];
  const readout = document.getElementById('profile-readout')!;
  // Real time along the track (ms since epoch), interpolated by distance.
  const startMs = data.start ? Date.parse(data.start) : null;
  const timed = startMs != null && data.track.every((p) => p[4] != null);
  const timeAt = (m: number) => {
    const tr = data.track;
    let i = tr.findIndex((p) => p[3] >= m);
    if (i <= 0) return startMs! + (tr[i < 0 ? tr.length - 1 : 0][4] as number) * 1000;
    const [a, b] = [tr[i - 1], tr[i]];
    const f = (m - a[3]) / Math.max(b[3] - a[3], 1e-6);
    return startMs! + ((a[4] as number) + f * ((b[4] as number) - (a[4] as number))) * 1000;
  };

  const showAt = (m: number | null) => {
    if (m == null) {
      rider.visible = playing;
      if (!playing) readout.textContent = 'Hover or drag to explore';
      return;
    }
    rider.visible = true;
    pointAt(pts, dist, m, rider.position);
    const i = Math.min(data.track.length - 1, data.track.findIndex((p) => p[3] >= m));
    const ele = data.track[Math.max(i, 0)][2];
    const parts = [`${miles(m).toFixed(1)} mi`, `${Math.round(feet(ele)).toLocaleString('en-US')} ft`];
    if (timed) parts.unshift(fmtClock(timeAt(m)));
    const near = stops.find((st) => Math.abs(st.m - m) < total * 0.004);
    if (near && !playing) parts.splice(0, 1, `${fmtStop(near)}: ${fmtClock(Date.parse(near.start))} → ${fmtClock(Date.parse(near.end))}`);
    readout.textContent = parts.join(' · ');
    profile.setCursor(m);
  };
  const stops = data.stops ?? [];
  const profile = new Profile(
    document.getElementById('profile') as HTMLCanvasElement,
    data.track,
    stops.map((st) => ({ m: st.m, label: fmtStop(st) })),
    (m) => {
      if (playing) stopPlay();
      showAt(m);
    },
  );

  // Play Ride: chase camera that follows the marker along the track.
  const playBtn = document.getElementById('play') as HTMLButtonElement;
  let playing = false;
  let progress = 0;
  let last = 0;
  const duration = THREE.MathUtils.clamp(miles(total) * 2.2, 20, 60) * 1000;
  // Playback follows the recorded clock, so the marker slows on climbs and speeds up on
  // descents. Pauses longer than two minutes (lunch, camp, overnight) are squeezed out.
  const clock: number[] = [0];
  for (let i = 1; i < data.track.length; i++) {
    const dt = timed ? (data.track[i][4] as number) - (data.track[i - 1][4] as number) : data.track[i][3] - data.track[i - 1][3];
    clock.push(clock[i - 1] + (timed && dt > 120 ? 5 : Math.max(dt, 0)));
  }
  const clockEnd = clock[clock.length - 1] || 1;
  const distAt = (progress: number) => {
    const c = progress * clockEnd;
    const tr = data.track;
    let i = clock.findIndex((v) => v >= c);
    if (i <= 0) return i < 0 ? total : 0;
    const f = (c - clock[i - 1]) / Math.max(clock[i] - clock[i - 1], 1e-6);
    return tr[i - 1][3] + f * (tr[i][3] - tr[i - 1][3]);
  };
  const look = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const desired = new THREE.Vector3();
  // At each stop the marker waits while the clock runs through it; Skip jumps to departure.
  const card = document.getElementById('stop-card')!;
  const skipBtn = document.getElementById('skip') as HTMLButtonElement;
  let nextStop = 0;
  let hold: { st: Stop; t0: number; dur: number } | null = null;
  const endHold = () => {
    hold = null;
    card.hidden = true;
  };
  const beginHold = (st: Stop, now: number) => {
    const hours = (Date.parse(st.end) - Date.parse(st.start)) / 3.6e6;
    const dur = st.nights > 0 ? THREE.MathUtils.clamp(hours * 350, 6000, 16000) : THREE.MathUtils.clamp(hours * 1200, 1500, 3500);
    hold = { st, t0: now, dur };
    document.getElementById('stop-title')!.textContent = fmtStop(st);
    document.getElementById('stop-range')!.textContent = `${fmtClock(Date.parse(st.start))} → ${fmtClock(Date.parse(st.end))}`;
    skipBtn.hidden = st.nights === 0;
    card.hidden = false;
  };
  skipBtn.addEventListener('click', () => {
    if (hold) hold.t0 = -Infinity;
  });

  const startPlay = () => {
    if (progress >= 1) progress = 0;
    const here = distAt(progress);
    nextStop = stops.findIndex((st) => st.m > here + 1);
    if (nextStop < 0) nextStop = stops.length;
    playing = true;
    last = performance.now();
    controls.enabled = false;
    playBtn.textContent = '❚❚ Pause';
    look.copy(pointAt(pts, dist, distAt(progress)));
  };
  const stopPlay = () => {
    playing = false;
    endHold();
    controls.enabled = true;
    controls.target.copy(look);
    playBtn.textContent = progress >= 1 ? '↺ Replay' : '▶ Play Ride';
  };
  playBtn.addEventListener('click', () => (playing ? stopPlay() : startPlay()));
  renderer.domElement.addEventListener('pointerdown', () => {
    flight = null;
    if (playing) stopPlay();
  });
  renderer.domElement.addEventListener('wheel', () => (flight = null), { passive: true });
  addEventListener('keydown', (e) => {
    if (e.key === ' ' && e.target === document.body) {
      e.preventDefault();
      playBtn.click();
    }
    if (e.key === 'Escape') {
      if (playing) stopPlay();
      resetView(true);
    }
  });

  const tick = (now: number) => {
    if (playing) {
      const dt = now - last;
      last = now;
      let m: number;
      if (hold) {
        const f = Math.min(1, (now - hold.t0) / hold.dur);
        const clockMs = Date.parse(hold.st.start) + f * (Date.parse(hold.st.end) - Date.parse(hold.st.start));
        document.getElementById('stop-clock')!.textContent = fmtClock(clockMs);
        m = hold.st.m;
        showAt(m);
        readout.textContent = `${fmtClock(clockMs)} · ${miles(m).toFixed(1)} mi`;
        if (f >= 1) endHold();
      } else {
        progress = Math.min(1, progress + dt / duration);
        m = distAt(progress);
        if (nextStop < stops.length && m >= stops[nextStop].m) {
          m = stops[nextStop].m;
          beginHold(stops[nextStop++], now);
        }
        showAt(m);
      }
      // Look a little ahead of the rider, camera trails behind and above.
      pointAt(pts, dist, Math.min(total, m + total * 0.04), ahead);
      const heading = ahead.clone().sub(rider.position).setY(0);
      if (heading.lengthSq() < 1e-6) heading.set(0, 0, -1);
      heading.normalize();
      desired
        .copy(rider.position)
        .addScaledVector(heading, -size * 0.3)
        .add(new THREE.Vector3(-heading.z, 0, heading.x).multiplyScalar(size * 0.08));
      desired.y = Math.max(rider.position.y, hm.y(hm.at(desired.x, -desired.z))) + size * 0.2;
      const k = 1 - Math.exp(-dt / 600);
      camera.position.lerp(desired, k);
      look.lerp(rider.position, Math.min(1, k * 2));
      camera.lookAt(look);
      if (progress >= 1) stopPlay();
    } else {
      if (flight) {
        const f = Math.min(1, (now - flight.t0) / 700);
        const e = f * f * (3 - 2 * f);
        const to = homeView();
        controls.target.lerpVectors(flight.from.target, to.target, e);
        camera.position.lerpVectors(flight.from.position, to.position, e);
        if (f >= 1) flight = null;
      }
      controls.update();
    }
    renderer.render(scene, camera);
    placeLabels();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  playBtn.disabled = false;
  await imagery;
  document.getElementById('loading')!.classList.add('done');
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById('loading')!;
  el.textContent = err instanceof Error ? err.message : 'Could not load this track.';
});
