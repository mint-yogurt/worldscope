// Ships (AIS): every vessel our server hears about in the current view, as
// hull arrows pointing where they're heading, colored by type. Moored and
// anchored ships are small dots. Click one for its details and recent track.
//
// Data via our server (server/sources/ships.js): Digitraffic (Finland/Baltic)
// always, plus aisstream.io worldwide when the server has a key.

import { THEMES } from '../themes.js';
import * as geo from '../geo.js';
import { esc } from './flight-panel.js';

export const CATEGORIES = [
  { id: 'cargo', name: 'Cargo' },
  { id: 'tanker', name: 'Tankers' },
  { id: 'passenger', name: 'Passenger & ferries' },
  { id: 'fishing', name: 'Fishing' },
  { id: 'service', name: 'Tugs, pilots & official' },
  { id: 'leisure', name: 'Sailing & pleasure' },
  { id: 'other', name: 'Other & unknown' },
];
const REFRESH_MS = 30_000;
const PICK_LAYERS = ['ships:ships'];
const CELL = 64;
// Flat icons on the globe's curved surface get cut by it; skip depth testing
// (the far side is hidden separately) so they're always whole.
const ON_TOP = { cullMode: 'none', depthCompare: 'always', depthWriteEnabled: false };
const HIDDEN_POS = [0, -89.9, -1e7];

const row = (r) => ({
  mmsi: r[0], lon: r[1], lat: r[2], course: r[3], sog: r[4], cat: r[5], stopped: r[6] === 1, name: r[7], age: r[8],
});

// Two white masks, tinted per ship: a pointed hull for ships under way, a dot for stopped ones.
function buildAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = CELL * 2;
  canvas.height = CELL;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  ctx.lineWidth = 4;
  ctx.beginPath(); // hull, bow up
  ctx.moveTo(32, 4);
  ctx.quadraticCurveTo(48, 22, 46, 58);
  ctx.lineTo(18, 58);
  ctx.quadraticCurveTo(16, 22, 32, 4);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(CELL + 32, 32, 16, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fill();
  return {
    canvas,
    mapping: {
      moving: { x: 0, y: 0, width: CELL, height: CELL, mask: true },
      stopped: { x: CELL, y: 0, width: CELL, height: CELL, mask: true },
    },
  };
}

function ago(s) {
  if (s < 90) return `${Math.round(s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export function createShips({ map, overlay, panelEl, extraEl, settings, save, onCount, onStatus, onSelect }) {
  const atlas = buildAtlas();
  let enabled = false;
  let colors = null;
  let palette = null;
  let themeId = null;
  let all = []; // rows in the last fetched area
  let shown = [];
  let sources = [];
  let total = 0;
  let fillingUp = false; // the server's feeds woke recently
  let fetched = null; // bbox [w, s, e, n] the data covers
  let pollTimer = 0;
  let loadToken = 0;
  let pending = null; // bbox query of the request in flight
  let raf = 0;
  let viewStamp = 0;
  let sel = null; // { mmsi, detail, following }

  overlay.tooltip('ships', (s) => (s?.mmsi
    ? `<b>${esc(s.name || `MMSI ${s.mmsi}`)}</b><br>${esc(CATEGORIES.find((c) => c.id === s.cat)?.name || '')}${
      s.stopped ? ' · stopped' : Number.isFinite(s.sog) ? ` · ${s.sog.toFixed(1)} kn` : ''}`
    : null));

  // --- Data ------------------------------------------------------------------------

  // The view plus a margin, or the whole world when zoomed out.
  function viewBbox() {
    if (map.getZoom() < 4) return [-180, -90, 180, 90];
    const b = map.getBounds();
    const padX = (b.getEast() - b.getWest()) * 0.5;
    const padY = (b.getNorth() - b.getSouth()) * 0.5;
    return [b.getWest() - padX, Math.max(-90, b.getSouth() - padY), b.getEast() + padX, Math.min(90, b.getNorth() + padY)];
  }

  function covered() {
    if (!fetched) return false;
    if (fetched[2] - fetched[0] >= 360) return true;
    const b = map.getBounds();
    return b.getWest() >= fetched[0] && b.getEast() <= fetched[2] && b.getSouth() >= fetched[1] && b.getNorth() <= fetched[3];
  }

  async function load() {
    const bbox = viewBbox();
    const query = bbox.map((v) => v.toFixed(3)).join(',');
    if (query === pending) return; // the same area is already on its way
    pending = query;
    const token = ++loadToken;
    try {
      const res = await fetch(`/api/ships?bbox=${query}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (token !== loadToken || !enabled) return;
      fetched = bbox;
      all = d.ships.map(row);
      total = d.total;
      sources = d.sources;
      fillingUp = d.fillingUp;
      applyFilters();
      if (sel) refreshSelected();
    } catch (err) {
      console.error(err);
      onStatus(`Ships failed to load: ${err.message}`);
    } finally {
      if (token === loadToken) pending = null;
    }
  }

  function passes(s) {
    return !settings.hidden.includes(s.cat) && (settings.stopped || !s.stopped);
  }

  function applyFilters() {
    // Stopped ships first so moving ones draw over them.
    shown = all.filter(passes).sort((a, b) => b.stopped - a.stopped);
    onCount(shown.length);
    const live = sources.filter((s) => s.ok).map((s) => s.name.replace(/\s*\(.*\)/, ''));
    const capped = total > all.length ? ` (busiest ${all.length.toLocaleString()} of ${total.toLocaleString()})` : '';
    onStatus(`⚓ ${shown.length.toLocaleString()} ships${capped}${fillingUp ? ' (filling up)' : ''}${live.length ? ` · ${live.join(' + ')}` : ''}`);
    renderFilters();
    viewStamp++;
    requestDraw();
  }

  // --- Drawing ---------------------------------------------------------------------

  function requestDraw() {
    if (enabled && !raf) raf = requestAnimationFrame(draw);
  }

  function sizePx(zoom) {
    if (zoom < 3) return 9;
    if (zoom < 9) return 9 + (zoom - 3) * 2;
    return 21 + Math.min(zoom - 9, 6);
  }

  function draw() {
    raf = 0;
    if (!enabled || !colors) return;
    const hidden = geo.globeOccluder(map, Infinity);
    const size = sizePx(map.getZoom());
    const bearing = map.getBearing();
    const layers = [];
    const selected = sel && shown.find((s) => s.mmsi === sel.mmsi);

    if (sel?.detail?.trail?.length && selected) {
      layers.push(new deck.PathLayer({
        id: 'ships:trail',
        data: [{ path: [...sel.detail.trail, [selected.lon, selected.lat]] }],
        getPath: (d) => d.path,
        getColor: [...colors.trail, 220],
        getWidth: 2.5,
        widthUnits: 'pixels',
        jointRounded: true,
        capRounded: true,
        wrapLongitude: true,
        parameters: ON_TOP,
      }));
    }
    if (selected && !hidden?.([selected.lon, selected.lat])) {
      layers.push(new deck.ScatterplotLayer({
        id: 'ships:selected',
        data: [selected],
        getPosition: (s) => [s.lon, s.lat],
        getRadius: size * 0.75 + 4,
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
    layers.push(new deck.IconLayer({
      id: 'ships:ships',
      data: shown,
      iconAtlas: atlas.canvas,
      iconMapping: atlas.mapping,
      getIcon: (s) => (s.stopped || !Number.isFinite(s.course) ? 'stopped' : 'moving'),
      // Hidden ships are parked far below the surface rather than filtered out,
      // so panning doesn't rebuild the data.
      getPosition: (s) => (hidden?.([s.lon, s.lat]) ? HIDDEN_POS : [s.lon, s.lat]),
      // deck.gl angles turn counter-clockwise on screen; compass courses turn
      // clockwise from north, and north is turned by the map's bearing.
      getAngle: (s) => bearing - (s.course || 0),
      getSize: (s) => (s.stopped || !Number.isFinite(s.course) ? size * 0.55 : size),
      getColor: (s) => [...(colors[s.cat] || colors.other), s.age > 1800 ? 150 : 255],
      sizeUnits: 'pixels',
      billboard: true,
      pickable: true,
      parameters: ON_TOP,
      updateTriggers: { getPosition: hidden ? viewStamp : 0, getColor: themeId, getAngle: bearing, getSize: size },
    }));
    overlay.set('ships', layers);
  }

  // --- Selection & panel -------------------------------------------------------------

  async function select(mmsi) {
    if (!mmsi) {
      sel = null;
      panelEl.hidden = true;
      requestDraw();
      return;
    }
    sel = { mmsi, detail: null, following: false };
    onSelect?.();
    renderPanel();
    refreshSelected();
  }

  async function refreshSelected() {
    const mine = sel;
    try {
      const res = await fetch(`/api/ships/${mine.mmsi}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (sel !== mine) return;
      mine.detail = d;
      renderPanel();
      if (mine.following) map.easeTo({ center: [d.lon, d.lat], duration: 800 });
      requestDraw();
    } catch (err) {
      if (sel === mine) panelEl.querySelector('[data-source]').textContent = `Details unavailable: ${err.message}`;
    }
  }

  function renderPanel() {
    const $ = (q) => panelEl.querySelector(q);
    const live = shown.find((s) => s.mmsi === sel.mmsi) || all.find((s) => s.mmsi === sel.mmsi);
    const d = sel.detail || {};
    const stat = (label, value) => (value == null || value === '' ? '' : `<div><dt>${label}</dt><dd title="${esc(value)}">${esc(value)}</dd></div>`);
    const num = (n, unit, digits = 1) => (Number.isFinite(n) ? `${n.toFixed(digits)}${unit}` : null);
    panelEl.hidden = false;
    $('[data-name]').textContent = d.name || live?.name || `MMSI ${sel.mmsi}`;
    const cat = d.category || live?.cat || 'other';
    $('[data-kind]').innerHTML = `<span class="ship-dot" style="--c:${palette[cat]}"></span>${esc(d.typeName || CATEGORIES.find((c) => c.id === cat)?.name || '')}`;
    const course = (d.sog >= 0.5 ? d.cog ?? d.heading : d.heading ?? d.cog) ?? live?.course;
    $('[data-stats]').innerHTML = [
      stat('Status', d.navText || (live?.stopped ? 'Stopped' : 'Under way')),
      stat('Speed', num(d.sog ?? live?.sog, ' kn')),
      stat('Heading', Number.isFinite(course) ? `${Math.round(course)}°` : null),
      stat('Destination', d.destination),
      stat('ETA', d.eta),
      stat('Size', d.length ? `${d.length} × ${d.beam || '?'} m` : null),
      stat('Draught', num(d.draught, ' m')),
      stat('Call sign', d.callsign),
      stat('IMO', d.imo),
      stat('MMSI', sel.mmsi),
    ].join('');
    $('[data-follow]').setAttribute('aria-pressed', String(sel.following));
    const age = d.at ? (Date.now() - d.at) / 1000 : live?.age;
    const src = { digitraffic: 'Digitraffic (Fintraffic)', aisstream: 'aisstream.io' }[d.source] || '';
    $('[data-source]').innerHTML = `${src ? `${esc(src)} · ` : ''}${Number.isFinite(age) ? `position ${ago(age)} · ` : ''}<a href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${sel.mmsi}" target="_blank" rel="noopener">MarineTraffic</a>`;
  }

  // --- Filters -----------------------------------------------------------------------

  function buildFilters() {
    extraEl.innerHTML = `
      <div data-cats></div>
      <label class="sub-row">
        <input type="checkbox" data-stopped>
        <span class="layer-name">Show moored &amp; anchored</span>
        <span class="sub-count" data-stopped-count></span>
      </label>
      <p class="ev-hint" data-coverage></p>`;
    extraEl.querySelector('[data-cats]').innerHTML = CATEGORIES.map((c) => `
      <label class="sub-row">
        <input type="checkbox" data-cat="${c.id}">
        <span class="ship-dot" data-swatch="${c.id}"></span>
        <span class="layer-name">${c.name}</span>
        <span class="sub-count" data-count="${c.id}"></span>
      </label>`).join('');
    extraEl.onchange = (e) => {
      if (e.target.dataset.cat) {
        settings.hidden = CATEGORIES.map((c) => c.id).filter((id) => !extraEl.querySelector(`[data-cat="${id}"]`).checked);
      } else if ('stopped' in e.target.dataset) {
        settings.stopped = e.target.checked;
      } else return;
      save();
      applyFilters();
    };
  }

  function renderFilters() {
    if (!extraEl.firstElementChild) buildFilters();
    const counts = {};
    let stopped = 0;
    for (const s of all) {
      if (s.stopped) stopped++;
      if (settings.stopped || !s.stopped) counts[s.cat] = (counts[s.cat] || 0) + 1;
    }
    for (const c of CATEGORIES) {
      extraEl.querySelector(`[data-cat="${c.id}"]`).checked = !settings.hidden.includes(c.id);
      extraEl.querySelector(`[data-count="${c.id}"]`).textContent = (counts[c.id] || 0).toLocaleString();
      if (palette) extraEl.querySelector(`[data-swatch="${c.id}"]`).style.setProperty('--c', palette[c.id]);
    }
    extraEl.querySelector('[data-stopped]').checked = settings.stopped;
    extraEl.querySelector('[data-stopped-count]').textContent = stopped.toLocaleString();
    const worldwide = sources.find((s) => s.name.startsWith('aisstream'));
    extraEl.querySelector('[data-coverage]').textContent = worldwide?.enabled
      ? (worldwide.ok === false ? `Worldwide feed unavailable: ${worldwide.error}`
        : fillingUp ? 'The ship feed sleeps when nobody is viewing, so the map takes about 20 minutes to fill up after waking.'
          : 'Coverage comes from coastal receivers, so ships far out at sea are missing.')
      : 'Showing Finnish & Baltic waters only. Add a free aisstream.io key on the server for worldwide coastal coverage.';
  }

  // --- Wiring ------------------------------------------------------------------------

  panelEl.querySelector('[data-close]').addEventListener('click', () => select(null));
  panelEl.querySelector('[data-follow]').addEventListener('click', () => {
    if (!sel) return;
    sel.following = !sel.following;
    if (sel.following && sel.detail) map.easeTo({ center: [sel.detail.lon, sel.detail.lat], duration: 800 });
    renderPanel();
  });
  map.on('dragstart', () => {
    if (sel?.following) { sel.following = false; renderPanel(); }
  });
  map.on('move', () => {
    if (!enabled || !geo.globeOccluder(map, Infinity)) return;
    viewStamp++;
    requestDraw();
  });
  map.on('zoom', requestDraw);
  map.on('rotate', requestDraw);
  map.on('moveend', () => {
    if (enabled && !covered()) load();
  });
  map.on('click', (e) => {
    if (!enabled) return;
    const info = overlay.pick(e.point, PICK_LAYERS);
    if (info?.object?.mmsi) select(info.object.mmsi);
    else if (sel && !overlay.pick(e.point)) select(null);
  });

  return {
    select,
    focus: (mmsi) => select(Number(mmsi)),
    selected: () => sel?.mmsi ?? null,
    deselect: () => { if (sel) select(null); },
    setTheme(id) {
      themeId = id;
      palette = THEMES[id].ships;
      colors = Object.fromEntries(Object.entries(palette).map(([k, v]) => [k, geo.hexToRgb(v)]));
      if (enabled) renderFilters();
      if (sel) renderPanel();
      requestDraw();
    },
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      extraEl.hidden = !on;
      clearInterval(pollTimer);
      if (!on) {
        cancelAnimationFrame(raf);
        raf = 0;
        select(null);
        all = shown = [];
        fetched = null;
        overlay.set('ships', []);
        onCount(null);
        onStatus('');
        return;
      }
      renderFilters();
      onStatus('⚓ Loading ships…');
      load();
      pollTimer = setInterval(load, REFRESH_MS);
    },
  };
}
