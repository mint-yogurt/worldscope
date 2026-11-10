// Radiation: latest gamma dose rate at monitoring stations, colored on a fixed
// scale (the same in every theme, since the colors carry meaning), plus
// Safecast's survey map of everything its volunteers have measured.
// Click a station for its reading and, for official stations, the last week.
//
// Data via our server (server/sources/radiation.js): BfS (Germany),
// STUK/FMI (Finland), Safecast live sensors (worldwide).

import * as geo from '../geo.js';
import { OVERLAY_BEFORE_ID } from '../map.js';
import { esc } from './flight-panel.js';

// µSv/h bands. Natural background is mostly 0.05–0.3 depending on rock and altitude.
export const LEVELS = [
  { max: 0.1, color: '#3ccf91', label: 'Low' },
  { max: 0.2, color: '#a6d96a', label: 'Normal' },
  { max: 0.5, color: '#ffd166', label: 'Elevated' },
  { max: 1, color: '#ff9f43', label: 'High' },
  { max: 10, color: '#ff3b5c', label: 'Very high' },
  { max: Infinity, color: '#c03bff', label: 'Extreme' },
];
const levelOf = (v) => LEVELS.find((l) => v < l.max);
const LEVEL_RGB = new Map(LEVELS.map((l) => [l, geo.hexToRgb(l.color)]));
const SRC = {
  bfs: { kind: 'Official station', where: 'Germany', credit: 'Bundesamt für Strahlenschutz (BfS)', url: 'https://odlinfo.bfs.de/' },
  stuk: { kind: 'Official station', where: 'Finland', credit: 'STUK via Finnish Meteorological Institute (CC BY 4.0)', url: 'https://www.stuk.fi/' },
  safecast: { kind: 'Volunteer sensor', where: null, credit: 'Safecast (CC0)', url: 'https://safecast.org/' },
};
const REFRESH_MS = 10 * 60_000;
const PICK_LAYERS = ['radiation:stations'];
const ON_TOP = { cullMode: 'none', depthCompare: 'always', depthWriteEnabled: false };
const SURVEY_ID = 'radiation-safecast';

function ago(ms) {
  const min = Math.max(0, (Date.now() - ms) / 60_000);
  if (min < 60) return `${Math.round(min)} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}
const usv = (v) => `${v.toFixed(v < 1 ? 3 : 2)} µSv/h`;

// Small line chart of a week of readings, with the level bands behind it.
function sparkline(points) {
  const W = 300;
  const H = 70;
  const vals = points.map((p) => p[1]);
  const lo = Math.min(...vals) * 0.9;
  const hi = Math.max(...vals) * 1.1 || 1;
  const t0 = points[0][0];
  const t1 = points.at(-1)[0];
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * W;
  const y = (v) => H - ((v - lo) / (hi - lo || 1)) * H;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const color = levelOf(Math.max(...vals)).color;
  return `<svg class="rad-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Dose rate over the last ${Math.round((t1 - t0) / 864e5)} days">
    <path d="${path}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>
    <div class="rad-chart-axis"><span>${usv(Math.min(...vals))} min</span><span>${usv(Math.max(...vals))} max</span></div>`;
}

export function createRadiation({ map, overlay, panelEl, extraEl, settings, save, onCount, onStatus, onSelect }) {
  let enabled = false;
  let stations = [];
  let sources = [];
  let refreshTimer = 0;
  let retryTimer = 0;
  let raf = 0;
  let loadToken = 0;
  let loading = null;
  let sel = null; // { id, station, history }

  overlay.tooltip('radiation', (s) => (s?.id
    ? `<b>${esc(s.name)}</b><br>${usv(s.value)} · ${esc(levelOf(s.value).label.toLowerCase())}`
    : null));

  // --- Data ------------------------------------------------------------------------

  async function load() {
    const token = ++loadToken;
    try {
      const res = await fetch('/api/radiation');
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (token !== loadToken || !enabled) return;
      // Highest readings last so they draw on top.
      stations = d.stations.sort((a, b) => a.value - b.value);
      sources = d.sources;
      onCount(stations.length);
      const failing = sources.filter((s) => !s.ok).map((s) => s.name);
      onStatus(`☢ ${stations.length.toLocaleString()} stations${failing.length ? ` · ${failing.join(', ')} unavailable` : ''}`);
      // A source that was slow or down is often back within a minute.
      clearTimeout(retryTimer);
      if (failing.length) retryTimer = setTimeout(load, 60_000);
      renderExtra();
      if (sel) {
        const s = stations.find((x) => x.id === sel.id);
        if (s) { sel.station = s; renderPanel(); }
      }
      requestDraw();
    } catch (err) {
      console.error(err);
      onStatus(`Radiation failed to load: ${err.message}`);
    }
  }

  // --- Drawing ---------------------------------------------------------------------

  function requestDraw() {
    if (enabled && !raf) raf = requestAnimationFrame(draw);
  }

  function draw() {
    raf = 0;
    if (!enabled) return;
    const hidden = geo.globeOccluder(map, Infinity);
    const visible = hidden ? stations.filter((s) => !hidden([s.lon, s.lat])) : stations;
    const zoom = map.getZoom();
    const r = zoom < 4 ? 3.5 : zoom < 7 ? 3.5 + (zoom - 4) : 6.5 + Math.min(zoom - 7, 4) * 0.5;
    const layers = [new deck.ScatterplotLayer({
      id: 'radiation:stations',
      data: visible,
      getPosition: (s) => [s.lon, s.lat],
      getRadius: (s) => (s.src === 'safecast' ? r + 1.5 : r),
      getFillColor: (s) => LEVEL_RGB.get(levelOf(s.value)),
      // Volunteer sensors get a white ring to tell them apart from official stations.
      getLineColor: (s) => (s.src === 'safecast' ? [255, 255, 255, 230] : [0, 0, 0, 170]),
      getLineWidth: (s) => (s.src === 'safecast' ? 1.5 : 1),
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      stroked: true,
      billboard: true,
      pickable: true,
      parameters: ON_TOP,
      updateTriggers: { getRadius: r },
    })];
    const s = sel && visible.find((x) => x.id === sel.id);
    if (s) {
      layers.push(new deck.ScatterplotLayer({
        id: 'radiation:selected',
        data: [s],
        getPosition: (x) => [x.lon, x.lat],
        getRadius: r + 6,
        getLineColor: [255, 255, 255, 255],
        radiusUnits: 'pixels',
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        stroked: true,
        filled: false,
        billboard: true,
        parameters: ON_TOP,
      }));
    }
    overlay.set('radiation', layers);
  }

  // Safecast's own tiles, through our server (their bucket has no CORS headers).
  function setSurvey(on) {
    if (on && !map.getSource(SURVEY_ID)) {
      map.addSource(SURVEY_ID, {
        type: 'raster',
        tiles: [`${location.origin}/tiles/safecast/{z}/{x}/{y}.png`],
        tileSize: 512,
        maxzoom: 16,
        attribution: '<a href="https://safecast.org/" target="_blank" rel="noopener">Safecast</a>',
      });
      map.addLayer({ id: SURVEY_ID, type: 'raster', source: SURVEY_ID, paint: { 'raster-opacity': 0.75 } },
        map.getLayer(OVERLAY_BEFORE_ID) ? OVERLAY_BEFORE_ID : undefined);
    } else if (!on && map.getSource(SURVEY_ID)) {
      map.removeLayer(SURVEY_ID);
      map.removeSource(SURVEY_ID);
    }
  }

  // --- Selection & panel -------------------------------------------------------------

  async function select(id) {
    if (!id) {
      sel = null;
      panelEl.hidden = true;
      requestDraw();
      return;
    }
    const station = stations.find((s) => s.id === id);
    if (!station) return;
    sel = { id, station, history: null };
    onSelect?.();
    renderPanel();
    requestDraw();
    try {
      const res = await fetch(`/api/radiation/${encodeURIComponent(id)}/history`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (sel?.id === id) { sel.history = d; renderPanel(); }
    } catch (err) {
      if (sel?.id === id) { sel.history = { points: [], error: err.message }; renderPanel(); }
    }
  }

  function renderPanel() {
    const $ = (q) => panelEl.querySelector(q);
    const s = sel.station;
    const src = SRC[s.src];
    const level = levelOf(s.value);
    const stat = (label, value) => (value == null || value === '' ? '' : `<div><dt>${label}</dt><dd>${value}</dd></div>`);
    panelEl.hidden = false;
    $('[data-name]').textContent = s.name;
    $('[data-kind]').textContent = [src.kind, s.info.region, src.where || s.country].filter(Boolean).join(' · ');
    $('[data-reading]').innerHTML = `
      <b style="color:${level.color}">${usv(s.value)}</b>
      <span class="rad-level" style="--c:${level.color}">${level.label}</span>`;
    const h = sel.history;
    const chart = $('[data-chart]');
    chart.hidden = s.src === 'safecast' || (h && h.points.length < 2);
    chart.innerHTML = !h ? '<p class="ev-credit">Loading the last week…</p>'
      : h.points.length >= 2 ? `<h4>Last ${Math.round((h.points.at(-1)[0] - h.points[0][0]) / 864e5)} days, hourly</h4>${sparkline(h.points)}` : '';
    const i = s.info;
    $('[data-stats]').innerHTML = [
      stat('Measured', `<span title="${new Date(s.at).toISOString().slice(0, 16).replace('T', ' ')} UTC">${ago(s.at)}</span>`),
      stat('Averaged over', i.averaged),
      i.cpm != null && stat('Counts', `${i.cpm} CPM (${esc(i.tube)})`),
      Number.isFinite(i.terrestrial) && stat('From the ground', usv(i.terrestrial)),
      Number.isFinite(i.cosmic) && stat('From space', usv(i.cosmic)),
      Number.isFinite(i.heightM) && stat('Elevation', `${i.heightM} m`),
      stat('Location', `${s.lat.toFixed(3)}°, ${s.lon.toFixed(3)}°`),
    ].filter(Boolean).join('');
    $('[data-note]').textContent = s.src === 'safecast'
      ? 'Volunteer sensor; the dose rate is estimated from its counts per minute.'
      : 'Rain can briefly raise readings as it washes natural radon products out of the air.';
    $('[data-source]').innerHTML = `Source: <a href="${src.url}" target="_blank" rel="noopener">${esc(src.credit)}</a>${
      i.dashboard ? ` · <a href="${esc(i.dashboard)}" target="_blank" rel="noopener">sensor page</a>` : ''}`;
  }

  // --- Legend & settings -------------------------------------------------------------

  function renderExtra() {
    if (!extraEl.firstElementChild) {
      extraEl.innerHTML = `
        <div class="rad-legend">${LEVELS.map((l, i) => `
          <span><i style="background:${l.color}"></i>${l.label}<small>${i ? `${LEVELS[i - 1].max}` : '0'}${l.max === Infinity ? '+' : `–${l.max}`}</small></span>`).join('')}
        </div>
        <p class="ev-hint">µSv/h. Natural background is usually 0.05–0.3 depending on rock and altitude. Dots with a white ring are volunteer sensors.</p>
        <label class="sub-row">
          <input type="checkbox" data-survey>
          <span class="layer-name">Safecast survey map</span>
        </label>
        <p class="ev-hint">Every reading Safecast volunteers have logged, mostly from drives. Not live.</p>
        <p class="ev-hint" data-sources></p>`;
      extraEl.querySelector('[data-survey]').addEventListener('change', (e) => {
        settings.survey = e.target.checked;
        save();
        setSurvey(settings.survey);
      });
    }
    extraEl.querySelector('[data-survey]').checked = settings.survey;
    extraEl.querySelector('[data-sources]').innerHTML = sources.length
      ? `Stations: ${sources.map((s) => `<a href="${s.url}" target="_blank" rel="noopener">${esc(s.name)}</a> ${s.ok ? s.count.toLocaleString() : 'unavailable'}`).join(' · ')}`
      : '';
  }

  // --- Wiring ------------------------------------------------------------------------

  panelEl.querySelector('[data-close]').addEventListener('click', () => select(null));
  map.on('move', requestDraw);
  map.on('click', (e) => {
    if (!enabled) return;
    const info = overlay.pick(e.point, PICK_LAYERS);
    if (info?.object?.id) select(info.object.id);
    else if (sel && !overlay.pick(e.point)) select(null);
  });

  return {
    select,
    async focus(id) {
      await loading;
      select(id);
    },
    selected: () => sel?.id ?? null,
    deselect: () => { if (sel) select(null); },
    setTheme() { /* fixed, meaningful colors in every theme */ },
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      extraEl.hidden = !on;
      clearInterval(refreshTimer);
      clearTimeout(retryTimer);
      setSurvey(on && settings.survey);
      if (!on) {
        cancelAnimationFrame(raf);
        raf = 0;
        select(null);
        overlay.set('radiation', []);
        onCount(null);
        onStatus('');
        return;
      }
      renderExtra();
      onStatus('☢ Loading radiation…');
      loading = load();
      refreshTimer = setInterval(load, REFRESH_MS);
    },
  };
}
