// Animated wind flow: thousands of short-lived particles advected through a
// global u/v wind grid (NOAA GFS via /api/weather/wind), drawn on a canvas
// over the map. Trails fade with destination-out so the map shows through.
// Particles pause while the map moves and reseed when it stops.

import * as geo from '../geo.js';

const MAX_AGE = 90;
// Alpha by wind speed (m/s): calm air is faint, strong wind is bright.
const SPEED_BUCKETS = [[3, 0.3], [8, 0.5], [15, 0.75], [Infinity, 1]];

export function createWindParticles(map, canvas) {
  const ctx = canvas.getContext('2d');
  let field = null;
  let running = false;
  let moving = false;
  let raf = 0;
  let particles = [];
  let w = 0;
  let h = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.max(600, Math.min(4500, Math.round((w * h) / 450)));
    particles = Array.from({ length: count }, () => ({ age: MAX_AGE }));
  }

  // Bilinear u/v at a point; null outside the grid.
  function sample(lon, lat) {
    const { nx, ny, la1, lo1, dx, dy, u, v } = field;
    const x = ((((lon - lo1) % 360) + 360) % 360) / dx;
    const y = (lat - la1) / dy;
    if (!(y >= 0 && y <= ny - 1)) return null;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = (x0 + 1) % nx;
    const y1 = Math.min(y0 + 1, ny - 1);
    const fx = x - x0;
    const fy = y - y0;
    const i00 = y0 * nx + x0;
    const i10 = y0 * nx + x1;
    const i01 = y1 * nx + x0;
    const i11 = y1 * nx + x1;
    const lerp = (a) => (a[i00] * (1 - fx) + a[i10] * fx) * (1 - fy) + (a[i01] * (1 - fx) + a[i11] * fx) * fy;
    return [lerp(u), lerp(v)];
  }

  // On the globe, the far side still projects onto the screen; hide it by angle from center.
  function onVisibleSide(lon, lat, center, globe) {
    return !globe || geo.distanceM(center, [lon, lat]) < 8_600_000; // ~77°
  }

  function spawn(p, center, globe) {
    for (let tries = 0; tries < 5; tries++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const ll = map.unproject([x, y]);
      // Off the globe, unproject snaps to the edge; reject points that don't round-trip.
      const back = map.project(ll);
      if (Math.abs(back.x - x) > 1 || Math.abs(back.y - y) > 1) continue;
      if (!onVisibleSide(ll.lng, ll.lat, center, globe)) continue;
      p.lon = ll.lng;
      p.lat = ll.lat;
      p.x = x;
      p.y = y;
      p.age = Math.floor(Math.random() * MAX_AGE);
      return;
    }
    p.age = MAX_AGE; // try again next frame
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    if (moving || !field) return;

    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';

    const zoom = map.getZoom();
    const c = map.getCenter();
    const center = [c.lng, c.lat];
    const globe = map.getProjection?.()?.type === 'globe';
    const k = (0.2 * 360) / (512 * 2 ** zoom); // degrees moved per (m/s) per frame
    const paths = SPEED_BUCKETS.map(() => new Path2D());

    for (const p of particles) {
      if (p.age++ >= MAX_AGE) { spawn(p, center, globe); continue; }
      const uv = sample(p.lon, p.lat);
      if (!uv) { p.age = MAX_AGE; continue; }
      const lat = p.lat + uv[1] * k;
      const lon = p.lon + (uv[0] * k) / Math.max(0.2, Math.cos((p.lat * Math.PI) / 180));
      const np = map.project([lon, lat]);
      if (np.x < 0 || np.y < 0 || np.x > w || np.y > h || !onVisibleSide(lon, lat, center, globe)) {
        p.age = MAX_AGE;
        continue;
      }
      const speed = Math.hypot(uv[0], uv[1]);
      const b = SPEED_BUCKETS.findIndex(([max]) => speed < max);
      paths[b].moveTo(p.x, p.y);
      paths[b].lineTo(np.x, np.y);
      p.lon = lon;
      p.lat = lat;
      p.x = np.x;
      p.y = np.y;
    }

    ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--wind').trim() || '#fff';
    ctx.lineWidth = 1.3;
    paths.forEach((path, i) => {
      ctx.globalAlpha = SPEED_BUCKETS[i][1];
      ctx.stroke(path);
    });
    ctx.globalAlpha = 1;
  }

  const reset = () => {
    ctx.clearRect(0, 0, w, h);
    for (const p of particles) p.age = MAX_AGE;
  };
  map.on('movestart', () => { moving = true; ctx.clearRect(0, 0, w, h); });
  map.on('moveend', () => { moving = false; reset(); });
  window.addEventListener('resize', () => { if (running) resize(); });

  return {
    setField(f) {
      field = f;
      reset();
    },
    setRunning(on) {
      if (on === running) return;
      running = on;
      canvas.hidden = !on;
      if (on) {
        resize();
        raf = requestAnimationFrame(frame);
      } else {
        cancelAnimationFrame(raf);
        ctx.clearRect(0, 0, w, h);
      }
    },
  };
}
