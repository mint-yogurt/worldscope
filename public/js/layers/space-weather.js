// Space weather layer:
//   - night shading with civil/nautical/astronomical twilight, and a Sun marker
//   - an animated aurora drawn from NOAA's OVATION probability grid: the shape and
//     brightness are real, the shimmering curtains are a simulation on top
//   - a status card: Kp index, solar wind, Bz, NOAA G/S/R scales, latest alerts
// Both shaded layers are canvases in Web Mercator, used as MapLibre canvas sources.

import { THEMES } from '../themes.js';
import { OVERLAY_BEFORE_ID } from '../map.js';
import * as geo from '../geo.js';
import { esc } from './flight-panel.js';

const MAX_LAT = 85.0511;
const CORNERS = [[-180, MAX_LAT], [180, MAX_LAT], [180, -MAX_LAT], [-180, -MAX_LAT]];
const NIGHT_SIZE = 360;
const AURORA_W = 720;
const AURORA_H = 720;
const AURORA_FPS = 20;

const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function kpLabel(kp) {
  if (kp >= 9) return 'G5 extreme storm';
  if (kp >= 8) return 'G4 severe storm';
  if (kp >= 7) return 'G3 strong storm';
  if (kp >= 6) return 'G2 moderate storm';
  if (kp >= 5) return 'G1 minor storm';
  if (kp >= 4) return 'active';
  return kp >= 3 ? 'unsettled' : 'quiet';
}

export function createSpaceWeather({ map, overlay, extraEl, onStatus }) {
  let enabled = false;
  let theme = null;
  let sun = geo.subsolarPoint();
  let aurora = null; // { pixels: Int32Array, lon: Float32Array, lat: Float32Array, v: Float32Array }
  let auroraMeta = null;
  let auroraTimer = 0;
  let summaryTimer = 0;
  let nightTimer = 0;
  let raf = 0;
  let lastAuroraDraw = 0;

  const nightCanvas = Object.assign(document.createElement('canvas'), { width: NIGHT_SIZE, height: NIGHT_SIZE });
  const auroraCanvas = Object.assign(document.createElement('canvas'), { width: AURORA_W, height: AURORA_H });
  const auroraCtx = auroraCanvas.getContext('2d');
  const auroraImg = auroraCtx.createImageData(AURORA_W, AURORA_H);

  overlay.tooltip('space', () => 'Subsolar point: the Sun is directly overhead here');

  // --- Night ---------------------------------------------------------------------

  function drawNight() {
    sun = geo.subsolarPoint();
    const ctx = nightCanvas.getContext('2d');
    const img = ctx.createImageData(NIGHT_SIZE, NIGHT_SIZE);
    const [r, g, b] = geo.hexToRgb(theme.map.space);
    for (let y = 0; y < NIGHT_SIZE; y++) {
      const lat = geo.mercatorRowLat(y + 0.5, NIGHT_SIZE);
      for (let x = 0; x < NIGHT_SIZE; x++) {
        const lon = -180 + (360 * (x + 0.5)) / NIGHT_SIZE;
        // 0 at sunset, full darkness at the end of astronomical twilight (-18°).
        const dark = smoothstep(0.5, -18, geo.sunElevation(lon, lat, sun));
        const k = (y * NIGHT_SIZE + x) * 4;
        img.data[k] = r;
        img.data[k + 1] = g;
        img.data[k + 2] = b;
        img.data[k + 3] = dark * 190;
      }
    }
    ctx.putImageData(img, 0, 0);
    drawOverlays();
  }

  // --- Aurora --------------------------------------------------------------------

  // Precompute which pixels of the aurora canvas have any probability, and their lat/lon/value.
  function prepareAurora(d) {
    const idx = [];
    const lons = [];
    const lats = [];
    const vals = [];
    const at = (lat, lon) => d.values[(90 - lat) * 360 + (((lon % 360) + 360) % 360)];
    for (let y = 0; y < AURORA_H; y++) {
      const lat = geo.mercatorRowLat(y + 0.5, AURORA_H);
      if (Math.abs(lat) < 35) continue;
      const la0 = Math.floor(lat);
      const fy = lat - la0;
      for (let x = 0; x < AURORA_W; x++) {
        const lon = -180 + (360 * (x + 0.5)) / AURORA_W;
        const lo0 = Math.floor(lon);
        const fx = lon - lo0;
        const v = (at(la0, lo0) * (1 - fx) + at(la0, lo0 + 1) * fx) * (1 - fy)
          + (at(Math.min(90, la0 + 1), lo0) * (1 - fx) + at(Math.min(90, la0 + 1), lo0 + 1) * fx) * fy;
        if (v < 2) continue;
        idx.push(y * AURORA_W + x);
        lons.push(lon);
        lats.push(lat);
        vals.push(v);
      }
    }
    aurora = { pixels: Int32Array.from(idx), lon: Float32Array.from(lons), lat: Float32Array.from(lats), v: Float32Array.from(vals) };
  }

  function drawAurora(now) {
    raf = requestAnimationFrame(drawAurora);
    if (!aurora || now - lastAuroraDraw < 1000 / AURORA_FPS) return;
    lastAuroraDraw = now;
    const t = now / 1000;
    const data = auroraImg.data;
    data.fill(0);
    const { pixels, lon, lat, v } = aurora;
    for (let i = 0; i < pixels.length; i++) {
      const lo = lon[i];
      const la = lat[i];
      // Curtain rays drifting along the oval, plus slower waves and a gentle pulse.
      const ray = 0.5 + 0.5 * Math.sin(lo * 0.9 + t * 1.7 + 3 * Math.sin(lo * 0.13 - t * 0.4));
      const wave = 0.65 + 0.35 * Math.sin(la * 0.8 - t * 0.9 + lo * 0.05);
      const strength = Math.min(1, v[i] / 30);
      const intensity = strength * (0.4 + 0.6 * ray * wave) * (0.85 + 0.15 * Math.sin(t * 0.5 + la));
      // Faint edges lean violet, the body is oxygen green, strong cores go whitish.
      const green = Math.min(1, (v[i] - 2) / 14);
      const core = Math.max(0, (v[i] - 35) / 40);
      const k = pixels[i] * 4;
      data[k] = 150 * (1 - green) + 70 * green + 140 * core;
      data[k + 1] = 70 * (1 - green) + 255 * green;
      data[k + 2] = 255 * (1 - green) + 140 * green + 80 * core;
      data[k + 3] = Math.min(255, intensity * 235);
    }
    auroraCtx.putImageData(auroraImg, 0, 0);
  }

  async function loadAurora() {
    const res = await fetch('/api/space/aurora');
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    auroraMeta = d;
    prepareAurora(d);
    renderCard();
  }

  // --- Sun marker ---------------------------------------------------------------------

  function drawOverlays() {
    if (!enabled) return;
    const [r, g, b] = geo.hexToRgb(theme.flights.low);
    // Terminator: every point 90° from the subsolar point, where the Sun is on the horizon.
    const quarter = (Math.PI / 2) * 6371008.8;
    const terminator = Array.from({ length: 181 }, (_, i) => geo.destination(sun, i * 2, quarter));
    overlay.set('space', [
      new deck.PathLayer({
        id: 'space:terminator',
        data: [{ path: terminator }],
        getPath: (d) => d.path,
        getColor: [r, g, b, 150],
        getWidth: 1.5,
        widthUnits: 'pixels',
        wrapLongitude: true,
      }),
      new deck.ScatterplotLayer({
        id: 'space:sun-glow',
        data: [sun],
        getPosition: (p) => p,
        getRadius: 26,
        radiusUnits: 'pixels',
        billboard: true,
        getFillColor: [r, g, b, 45],
      }),
      new deck.ScatterplotLayer({
        id: 'space:sun',
        data: [sun],
        getPosition: (p) => p,
        getRadius: 9,
        radiusUnits: 'pixels',
        billboard: true,
        getFillColor: [255, 236, 160, 255],
        getLineColor: [r, g, b, 255],
        lineWidthMinPixels: 2,
        stroked: true,
        pickable: true,
      }),
    ]);
  }

  // --- Status card ----------------------------------------------------------------------

  let summary = null;

  async function loadSummary() {
    const res = await fetch('/api/space/summary');
    summary = await res.json();
    if (!res.ok) throw new Error(summary.error || `HTTP ${res.status}`);
    renderCard();
  }

  function renderCard() {
    const s = summary;
    if (!s) return;
    const kp = s.kp ?? s.kp3h;
    const fmt = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '—');
    // Rough rule of thumb: aurora overhead reaches ~66° geomagnetic latitude at Kp 0, ~2° lower per Kp step.
    const reach = Number.isFinite(kp) ? Math.round(66 - 2.1 * kp) : null;
    extraEl.innerHTML = `
      <div class="sw-card">
        <div class="sw-kp-row">
          <span class="sw-label">Kp</span>
          <b class="sw-kp" data-level="${Math.min(9, Math.floor(kp || 0))}">${fmt(kp, 1)}</b>
          <span class="sw-state">${Number.isFinite(kp) ? kpLabel(kp) : ''}</span>
        </div>
        <div class="sw-meter"><i style="width:${Math.min(100, ((kp || 0) / 9) * 100)}%"></i></div>
        <dl class="sw-stats">
          <div><dt>Solar wind</dt><dd>${fmt(s.solarWind?.speed)} km/s</dd></div>
          <div><dt>Bz</dt><dd>${fmt(s.bz, 1)} nT</dd></div>
          <div><dt>NOAA scales</dt><dd>G${s.scales?.G ?? '–'} S${s.scales?.S ?? '–'} R${s.scales?.R ?? '–'}</dd></div>
          <div><dt>Aurora peak</dt><dd>${auroraMeta ? `${auroraMeta.max}%` : '—'}</dd></div>
        </dl>
        ${reach ? `<p class="sw-note">Aurora overhead around ${reach}° magnetic latitude and poleward. Negative Bz helps.</p>` : ''}
        ${s.alerts.length ? `<ul class="sw-alerts">${s.alerts.map((a) => `<li><time>${esc(a.time.slice(5, 16))}</time> ${esc(a.title)}</li>`).join('')}</ul>` : ''}
      </div>`;
  }

  // --- Map sources -------------------------------------------------------------------

  function addSources() {
    const before = map.getLayer(OVERLAY_BEFORE_ID) ? OVERLAY_BEFORE_ID : undefined;
    // animate: a static canvas source never picks up redraws; re-uploading a 360 px canvas is cheap.
    map.addSource('space-night', { type: 'canvas', canvas: nightCanvas, coordinates: CORNERS, animate: true });
    map.addLayer({ id: 'space-night', type: 'raster', source: 'space-night', paint: { 'raster-resampling': 'linear' } }, before);
    map.addSource('space-aurora', { type: 'canvas', canvas: auroraCanvas, coordinates: CORNERS, animate: true });
    map.addLayer({ id: 'space-aurora', type: 'raster', source: 'space-aurora', paint: { 'raster-resampling': 'linear' } }, before);
  }

  function removeSources() {
    for (const id of ['space-aurora', 'space-night']) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
  }

  const fail = (what) => (err) => {
    console.warn(`${what} failed:`, err.message);
    onStatus(`${what} failed: ${err.message}`);
  };

  return {
    setTheme(id) {
      theme = THEMES[id];
      if (enabled) drawNight();
    },
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      extraEl.hidden = !on;
      if (!on) {
        clearInterval(auroraTimer);
        clearInterval(summaryTimer);
        clearInterval(nightTimer);
        cancelAnimationFrame(raf);
        removeSources();
        overlay.set('space', []);
        onStatus('');
        return;
      }
      extraEl.innerHTML = '<div class="sw-card sw-loading">Loading space weather…</div>';
      addSources();
      drawNight();
      loadAurora().catch(fail('Aurora'));
      loadSummary().catch(fail('Space weather'));
      onStatus('☀ Night & aurora: NOAA SWPC');
      raf = requestAnimationFrame(drawAurora);
      nightTimer = setInterval(drawNight, 60_000);
      auroraTimer = setInterval(() => loadAurora().catch(fail('Aurora')), 10 * 60_000);
      summaryTimer = setInterval(() => loadSummary().catch(fail('Space weather')), 5 * 60_000);
    },
  };
}
