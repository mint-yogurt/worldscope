// Satellites: the whole active catalog (~17k objects from CelesTrak), moving in
// real time at their true altitude. Orbits are propagated in a worker once a
// second and interpolated per frame. Click one for its orbit, ground track,
// coverage footprint and details.

import { THEMES } from '../themes.js';
import * as geo from '../geo.js';
import { esc } from './flight-panel.js';

const CATEGORIES = [
  { id: 'station', name: 'Space stations' },
  { id: 'constellation', name: 'Broadband (Starlink, OneWeb…)' },
  { id: 'gnss', name: 'Navigation (GPS, Galileo…)' },
  { id: 'weather', name: 'Weather' },
  { id: 'geo', name: 'Geostationary' },
  { id: 'other', name: 'Everything else' },
];
const RADIUS = { station: 5, constellation: 1.2, gnss: 3, weather: 3, geo: 2.5, other: 2 };
// Starlink & co. are ~12k dots; keep them see-through so the Earth stays readable.
const ALPHA = { constellation: 150 };
const TICK_MS = 1000;
const PICK_LAYERS = ['satellites:points', 'satellites:labels'];
const EARTH_KM = 6371;

function orbitType(altKm, ecc) {
  if (ecc > 0.25) return 'Highly elliptical';
  if (Math.abs(altKm - 35786) < 1500) return 'Geostationary';
  if (altKm < 2000) return 'Low Earth orbit';
  return altKm < 35000 ? 'Medium Earth orbit' : 'High Earth orbit';
}

export function createSatellites({ map, overlay, panelEl, extraEl, settings, save, onCount, onStatus, onSelect }) {
  let enabled = false;
  let colors = null;
  let themeId = null;
  let sats = []; // OMM records from the server, same order as the worker's satrecs
  let worker = null;
  let prev = null; // { time, positions }
  let next = null;
  let visible = new Int32Array(0); // indices of satellites in enabled categories
  let tickTimer = 0;
  let raf = 0;
  let frame = 0;
  let loading = null; // the first load, for focus() to wait on
  let lastSlowUpdate = 0;
  let sel = null; // { index, orbit, periodMin, speed, following }
  let requestId = 0;
  const pos = new Float32Array(3);

  overlay.tooltip('satellites', (i) => {
    const s = sats[i];
    const p = positionOf(i, Date.now());
    return `<b>${esc(s.OBJECT_NAME)}</b><br>${p ? `${Math.round(p[2]).toLocaleString()} km up` : ''}`;
  });

  // --- Data ------------------------------------------------------------------------

  async function load() {
    onStatus('🛰 Loading satellite catalog…');
    const res = await fetch('/api/space/satellites');
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    sats = d.satellites;
    worker = new Worker(new URL('../workers/sat-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onWorker;
    worker.onerror = (e) => onStatus(`Satellites: worker failed (${e.message || 'see console'})`);
    worker.postMessage({ type: 'load', sats });
    buildFilters(d.satellites);
    updateVisible();
  }

  function onWorker({ data }) {
    if (data.type === 'loaded') {
      onStatus(`🛰 ${data.count.toLocaleString()} satellites (CelesTrak)`);
      tick();
    } else if (data.type === 'positions') {
      // Keep the last two snapshots and interpolate between them while drawing.
      if (!next || data.time > next.time) {
        prev = next || { time: data.time - TICK_MS, positions: data.positions };
        next = { time: data.time, positions: data.positions };
      }
    } else if (data.type === 'orbit' && sel && data.id === sel.orbitRequest) {
      sel.orbit = data.path.map(([lon, lat, alt]) => [lon, lat, alt * 1000]);
      sel.groundTrack = data.path.map(([lon, lat]) => [lon, lat]);
      sel.periodMin = data.periodMin;
      sel.speed = data.speed;
      renderPanel();
    }
  }

  function tick() {
    if (!enabled || !worker) return;
    // Ask for one second ahead so there's always a snapshot to interpolate toward.
    worker.postMessage({ type: 'positions', time: Date.now() + TICK_MS, id: ++requestId });
  }

  function positionOf(i, now) {
    if (!prev || !next) return null;
    const a = prev.positions;
    const b = next.positions;
    const k = i * 3;
    if (Number.isNaN(b[k])) return null;
    if (Number.isNaN(a[k])) return [b[k], b[k + 1], b[k + 2]];
    const t = Math.max(0, Math.min(1.5, (now - prev.time) / (next.time - prev.time || 1)));
    let dLon = b[k] - a[k];
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    return [a[k] + dLon * t, a[k + 1] + (b[k + 1] - a[k + 1]) * t, a[k + 2] + (b[k + 2] - a[k + 2]) * t];
  }

  function updateVisible() {
    const on = new Set(settings.categories);
    const idx = [];
    sats.forEach((s, i) => { if (on.has(s.category)) idx.push(i); });
    visible = Int32Array.from(idx);
    onCount(visible.length);
  }

  // --- Drawing -----------------------------------------------------------------------

  function draw() {
    raf = requestAnimationFrame(draw);
    if (!next) return;
    frame++;
    const now = Date.now();
    const hidden = geo.globeOccluder(map);
    const layers = [];

    if (sel) layers.push(...selectionLayers(now));

    layers.push(new deck.ScatterplotLayer({
      id: 'satellites:points',
      data: visible,
      getPosition: (i) => {
        const p = positionOf(i, now);
        // Park failed or Earth-blocked ones out of sight (deep underground).
        if (!p || hidden?.(p)) { pos[0] = 0; pos[1] = -89.9; pos[2] = -1e7; return pos; }
        pos[0] = p[0]; pos[1] = p[1]; pos[2] = p[2] * 1000;
        return pos;
      },
      getRadius: (i) => RADIUS[sats[i].category],
      getFillColor: (i) => [...colors[sats[i].category], ALPHA[sats[i].category] ?? 255],
      radiusUnits: 'pixels',
      billboard: true,
      pickable: true,
      updateTriggers: { getPosition: frame, getFillColor: themeId },
    }));

    // Name tags for the space stations.
    const stations = Array.from(visible).filter((i) => sats[i].category === 'station' && /^(ISS \(ZARYA\)|CSS \(TIANHE\)|TIANHE)/.test(sats[i].OBJECT_NAME));
    layers.push(new deck.TextLayer({
      id: 'satellites:labels',
      data: stations,
      getPosition: (i) => { const p = positionOf(i, now); return p ? [p[0], p[1], p[2] * 1000] : [0, -89.9, -1e7]; },
      getText: (i) => sats[i].OBJECT_NAME.startsWith('ISS') ? 'ISS' : 'Tiangong',
      getSize: 12,
      getColor: [...colors.station, 255],
      getPixelOffset: [0, -14],
      fontFamily: 'Share Tech Mono, monospace',
      fontWeight: 700,
      outlineWidth: 3,
      outlineColor: [0, 0, 0, 220],
      fontSettings: { sdf: true },
      billboard: true,
      pickable: true,
      parameters: { cullMode: 'none' }, // text is back-face culled on the globe otherwise
      updateTriggers: { getPosition: frame, getColor: themeId },
    }));

    overlay.set('satellites', layers);
    // Slower updates go by the clock, not frame count (background tabs throttle frames).
    if (sel && now - lastSlowUpdate > 500) {
      lastSlowUpdate = now;
      const p = sel.following && positionOf(sel.index, now);
      if (p) map.easeTo({ center: [p[0], p[1]], duration: 500, easing: (t) => t, essential: true });
      renderPanel();
    }
  }

  function selectionLayers(now) {
    const p = positionOf(sel.index, now);
    const layers = [];
    if (sel.orbit) {
      layers.push(new deck.PathLayer({
        id: 'satellites:orbit',
        data: [{ path: sel.orbit }],
        getPath: (d) => d.path,
        getColor: [...colors.orbit, 220],
        getWidth: 2,
        widthUnits: 'pixels',
        wrapLongitude: true,
      }));
      layers.push(new deck.PathLayer({
        id: 'satellites:ground-track',
        data: [{ path: sel.groundTrack }],
        getPath: (d) => d.path,
        getColor: [...colors.orbit, 110],
        getWidth: 1.5,
        widthUnits: 'pixels',
        wrapLongitude: true,
        ...(deck.PathStyleExtension && { extensions: [new deck.PathStyleExtension({ dash: true })], getDashArray: [4, 4] }),
      }));
    }
    if (p) {
      // Area of Earth that can see the satellite above the horizon.
      const reachM = Math.acos(EARTH_KM / (EARTH_KM + p[2])) * EARTH_KM * 1000;
      const ring = Array.from({ length: 73 }, (_, k) => geo.destination([p[0], p[1]], k * 5, reachM));
      layers.push(new deck.PolygonLayer({
        id: 'satellites:footprint',
        data: [{ polygon: ring }],
        getPolygon: (d) => d.polygon,
        getFillColor: [...colors.orbit, 28],
        getLineColor: [...colors.orbit, 150],
        getLineWidth: 1,
        lineWidthUnits: 'pixels',
        stroked: true,
        wrapLongitude: true,
        updateTriggers: { getPolygon: frame },
      }));
      layers.push(new deck.ScatterplotLayer({
        id: 'satellites:selected',
        data: [p],
        getPosition: (q) => [q[0], q[1], q[2] * 1000],
        getRadius: 8,
        radiusUnits: 'pixels',
        getFillColor: [255, 255, 255, 255],
        getLineColor: [...colors.orbit, 255],
        lineWidthMinPixels: 2,
        stroked: true,
        billboard: true,
      }));
    }
    return layers;
  }

  // --- Panel and filters -----------------------------------------------------------

  function renderPanel() {
    if (!sel) return;
    const s = sats[sel.index];
    const p = positionOf(sel.index, Date.now());
    const $ = (q) => panelEl.querySelector(q);
    panelEl.hidden = false;
    $('[data-name]').textContent = s.OBJECT_NAME;
    $('[data-kind]').textContent = CATEGORIES.find((c) => c.id === s.category)?.name || '';
    const launched = s.OBJECT_ID?.slice(0, 4);
    const epochHours = (Date.now() - Date.parse(`${s.EPOCH}Z`)) / 3600_000;
    const stat = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    const fmt = (n, d = 0) => (Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : '—');
    $('[data-stats]').innerHTML = [
      stat('Altitude', p ? `${fmt(p[2])} km` : '—'),
      stat('Speed', sel.speed ? `${fmt(sel.speed, 2)} km/s` : '—'),
      stat('Orbit', p ? orbitType(p[2], s.ECCENTRICITY) : '—'),
      stat('Period', sel.periodMin ? `${fmt(sel.periodMin, 1)} min` : '—'),
      stat('Inclination', `${fmt(s.INCLINATION, 1)}°`),
      stat('Position', p ? `${p[1].toFixed(1)}°, ${p[0].toFixed(1)}°` : '—'),
      stat('NORAD ID', esc(s.NORAD_CAT_ID)),
      stat('Launched', esc(launched || '—')),
    ].join('');
    $('[data-follow]').setAttribute('aria-pressed', String(!!sel.following));
    $('[data-source]').textContent = `CelesTrak elements from ${fmt(epochHours, 0)} h ago · ${esc(s.OBJECT_ID || '')}`;
  }

  function select(index) {
    sel = index == null ? null : { index, following: false, orbitRequest: ++requestId };
    if (!sel) {
      panelEl.hidden = true;
      return;
    }
    onSelect?.();
    worker.postMessage({ type: 'orbit', index, time: Date.now(), id: sel.orbitRequest });
    renderPanel();
  }

  function buildFilters(all) {
    const counts = {};
    for (const s of all) counts[s.category] = (counts[s.category] || 0) + 1;
    extraEl.innerHTML = CATEGORIES.map((c) => `
      <label class="sub-row">
        <input type="checkbox" data-cat="${c.id}" ${settings.categories.includes(c.id) ? 'checked' : ''}>
        <span class="sub-dot" data-cat-dot="${c.id}"></span>
        <span class="layer-name">${c.name}</span>
        <span class="sub-count">${(counts[c.id] || 0).toLocaleString()}</span>
      </label>`).join('');
    paintFilterDots();
    extraEl.onchange = (e) => {
      const cat = e.target.dataset.cat;
      if (!cat) return;
      settings.categories = CATEGORIES.map((c) => c.id).filter((id) =>
        extraEl.querySelector(`[data-cat="${id}"]`).checked);
      save();
      updateVisible();
    };
  }

  function paintFilterDots() {
    if (!colors) return;
    for (const dot of extraEl.querySelectorAll('[data-cat-dot]')) {
      dot.style.background = `rgb(${colors[dot.dataset.catDot].join(',')})`;
    }
  }

  panelEl.querySelector('[data-close]').addEventListener('click', () => select(null));
  panelEl.querySelector('[data-follow]').addEventListener('click', () => {
    if (!sel) return;
    sel.following = !sel.following;
    renderPanel();
  });
  map.on('dragstart', () => { if (sel?.following) { sel.following = false; renderPanel(); } });
  map.on('click', (e) => {
    if (!enabled) return;
    const info = overlay.pick(e.point, PICK_LAYERS);
    if (Number.isInteger(info?.object)) select(info.object);
    else if (sel && !overlay.pick(e.point)) select(null);
  });

  // --- Public API ----------------------------------------------------------------------

  return {
    select,
    // Search and links know the catalog number. Satellites move, so fly to wherever it is now.
    async focus(noradId) {
      await loading;
      const index = sats.findIndex((s) => s.NORAD_CAT_ID === Number(noradId));
      if (index < 0) return;
      select(index);
      for (let tries = 0; tries < 40 && sel?.index === index; tries++) {
        const p = positionOf(index, Date.now());
        if (p) { map.flyTo({ center: [p[0], p[1]], zoom: Math.min(map.getZoom(), 3), duration: 1500 }); return; }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    selected: () => (sel ? sats[sel.index].NORAD_CAT_ID : null),
    deselect: () => select(null),
    indexOf: (noradId) => sats.findIndex((s) => s.NORAD_CAT_ID === noradId),
    setTheme(id) {
      themeId = id;
      colors = Object.fromEntries(Object.entries(THEMES[id].satellites).map(([k, v]) => [k, geo.hexToRgb(v)]));
      paintFilterDots();
    },
    async setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      extraEl.hidden = !on;
      if (!on) {
        clearInterval(tickTimer);
        cancelAnimationFrame(raf);
        select(null);
        overlay.set('satellites', []);
        onCount(null);
        onStatus('');
        return;
      }
      try {
        if (!worker) await (loading = load());
        else onStatus(`🛰 ${sats.length.toLocaleString()} satellites (CelesTrak)`);
        updateVisible();
        tick();
        tickTimer = setInterval(tick, TICK_MS);
        raf = requestAnimationFrame(draw);
      } catch (err) {
        console.error(err);
        onStatus(`Satellites failed to load: ${err.message}`);
      }
    },
  };
}
