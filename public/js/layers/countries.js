// Countries & flags. Each landmass can be painted as its country's flag, and any
// country can be opened for a summary and live counts from the other layers.
//
// MapLibre can't clip a picture to a polygon, so the flags are map tiles drawn in the
// browser: the flags:// protocol below clips each country's shape on a canvas and
// draws its flag inside. Borders stay sharp and the server has nothing to do.
//
// Shapes: Natural Earth (public domain). Flags: flag-icons (MIT).

import { OVERLAY_BEFORE_ID } from '../map.js';
import { esc } from './flight-panel.js';

const TILE = 512;
const MAX_TILE_ZOOM = 6; // the 1:50m shapes hold no more detail than this
const MIN_FLAG_PX = 7; // smaller islands get a flat color instead of a tiny flag
const FLAG_ASPECT = 4 / 3;
const MAX_STRETCH = 1.6; // how far a flag may be squashed to fit a long, thin country

const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

function inRing(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// One separate piece of land: its outline in map units (0-1) and bounding box.
function buildPiece(rings) {
  const path = new Path2D();
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  rings.forEach((ring, r) => {
    ring.forEach(([lon, lat], i) => {
      const x = mercX(lon);
      const y = mercY(lat);
      if (i) path.lineTo(x, y); else path.moveTo(x, y);
      if (r === 0) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    });
    path.closePath();
  });
  return { path, x0, y0, x1, y1, area: (x1 - x0) * (y1 - y0), rings };
}

// Stretch the flag over the piece, so every stripe shows, up to a limit. Past that
// (Chile, Norway) keep some of its shape and let the ends be cut off.
function flagBox(p) {
  const w = p.x1 - p.x0;
  const h = p.y1 - p.y0;
  const ratio = (w / h) / FLAG_ASPECT;
  let dw = w;
  let dh = h;
  if (ratio > MAX_STRETCH) dh = w / (FLAG_ASPECT * MAX_STRETCH);
  else if (ratio < 1 / MAX_STRETCH) dw = (h * FLAG_ASPECT) / MAX_STRETCH;
  return [(p.x0 + p.x1) / 2 - dw / 2, (p.y0 + p.y1) / 2 - dh / 2, dw, dh];
}

export function createCountries({ map, panelEl, extraEl, overlay, settings, save, onSelect, onOpen, onStatus }) {
  let enabled = false;
  let countries = null; // id -> country with `pieces`
  let loading = null;
  let version = 1;
  let accent = '#4fd1ff';
  let sel = null; // { id, country, detail }
  let clock = 0;
  const flags = new Map(); // iso -> Promise<{ image, average }>
  const shade = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });

  const $ = (q) => panelEl.querySelector(q);

  // --- Data ------------------------------------------------------------------------

  function load() {
    loading ??= (async () => {
      const res = await fetch('geo/countries.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json();
      countries = new Map(list.map((c) => [c.id, { ...c, pieces: c.polygons.map(buildPiece) }]));
      renderExtra();
    })();
    return loading;
  }

  function flag(iso) {
    let entry = flags.get(iso);
    if (entry) return entry;
    entry = (async () => {
      const image = new Image();
      image.src = `flags/${iso.toLowerCase()}.svg`;
      await image.decode();
      shade.clearRect(0, 0, 1, 1);
      shade.drawImage(image, 0, 0, 1, 1);
      const [r, g, b] = shade.getImageData(0, 0, 1, 1).data;
      return { image, average: `rgb(${r},${g},${b})` };
    })();
    flags.set(iso, entry);
    return entry;
  }

  function countryAt(lon, lat) {
    for (const c of countries.values()) {
      for (const p of c.pieces) {
        const [outer, ...holes] = p.rings;
        if (inRing(outer, lon, lat) && !holes.some((h) => inRing(h, lon, lat))) return c;
      }
    }
    return null;
  }

  // --- Flag tiles ------------------------------------------------------------------

  async function renderTile(z, x, y) {
    await load();
    const n = 2 ** z;
    const bounds = [x / n, y / n, (x + 1) / n, (y + 1) / n];
    const jobs = [];
    for (const c of countries.values()) {
      if (!c.iso || settings.hidden.includes(c.id)) continue;
      for (const p of c.pieces) {
        if (p.x1 >= bounds[0] && p.x0 <= bounds[2] && p.y1 >= bounds[1] && p.y0 <= bounds[3]) jobs.push({ c, p });
      }
    }
    const looks = await Promise.all(jobs.map(({ c }) => flag(c.iso).catch(() => null)));
    const canvas = new OffscreenCanvas(TILE, TILE);
    const ctx = canvas.getContext('2d');
    const scale = TILE * n;
    jobs.forEach(({ p }, i) => {
      const look = looks[i];
      if (!look) return;
      ctx.save();
      ctx.setTransform(scale, 0, 0, scale, -x * TILE, -y * TILE);
      ctx.clip(p.path, 'evenodd');
      if ((p.x1 - p.x0) * scale < MIN_FLAG_PX || (p.y1 - p.y0) * scale < MIN_FLAG_PX) {
        ctx.fillStyle = look.average;
        ctx.fillRect(p.x0, p.y0, p.x1 - p.x0, p.y1 - p.y0);
      } else {
        ctx.drawImage(look.image, ...flagBox(p));
      }
      ctx.restore();
    });
    return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
  }

  maplibregl.addProtocol('flags', async (params) => {
    const [, z, x, y] = params.url.match(/flags:\/\/(\d+)\/(\d+)\/(\d+)/).map(Number);
    return { data: await renderTile(z, x, y) };
  });

  const tileUrl = () => `flags://{z}/{x}/{y}?v=${version}`;

  function showFlags(on) {
    if (on && !map.getSource('flags')) {
      map.addSource('flags', {
        type: 'raster', tiles: [tileUrl()], tileSize: TILE, maxzoom: MAX_TILE_ZOOM,
        attribution: 'Flags: flag-icons · Borders: Natural Earth',
      });
      map.addLayer({
        id: 'flags', type: 'raster', source: 'flags',
        paint: { 'raster-opacity': settings.opacity, 'raster-fade-duration': 150 },
      }, OVERLAY_BEFORE_ID);
    }
    if (map.getLayer('flags')) map.setLayoutProperty('flags', 'visibility', on ? 'visible' : 'none');
  }

  function redrawFlags() {
    version++;
    map.getSource('flags')?.setTiles([tileUrl()]);
  }

  // --- Selected outline -------------------------------------------------------------

  function drawOutline() {
    const data = sel
      ? { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: sel.country.polygons } }
      : { type: 'FeatureCollection', features: [] };
    if (!map.getSource('country-sel')) {
      if (!sel) return;
      map.addSource('country-sel', { type: 'geojson', data });
      map.addLayer({ id: 'country-sel-fill', type: 'fill', source: 'country-sel', paint: { 'fill-color': accent, 'fill-opacity': 0.08 } }, OVERLAY_BEFORE_ID);
      map.addLayer({ id: 'country-sel-line', type: 'line', source: 'country-sel', paint: { 'line-color': accent, 'line-width': 1.6 } }, OVERLAY_BEFORE_ID);
      return;
    }
    map.getSource('country-sel').setData(data);
  }

  // --- Panel -----------------------------------------------------------------------

  const stat = (label, value) => (value == null || value === '' ? '' : `<div><dt>${label}</dt><dd title="${esc(String(value))}">${esc(String(value))}</dd></div>`);

  function languages(codes) {
    if (!codes) return null;
    const names = new Intl.DisplayNames(['en'], { type: 'language' });
    const seen = new Set();
    for (const code of codes.split(',')) {
      try { seen.add(names.of(code.split('-')[0])); } catch { /* not a code Intl knows */ }
      if (seen.size === 3) break;
    }
    return [...seen].join(', ') || null;
  }

  function localTime(tz) {
    if (!tz) return null;
    try {
      return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short' }).format(new Date());
    } catch {
      return null;
    }
  }

  function renderPanel() {
    const c = sel.country;
    const d = sel.detail;
    const now = d?.now;
    panelEl.hidden = false;
    const img = $('[data-flag]');
    img.hidden = !c.iso;
    if (c.iso) img.src = `flags/${c.iso.toLowerCase()}.svg`;
    $('[data-name]').textContent = c.name;
    $('[data-kind]').textContent = c.region || '';
    $('[data-summary]').textContent = d?.wiki?.extract || '';
    $('[data-summary]').hidden = !d?.wiki?.extract;
    $('[data-stats]').innerHTML = [
      stat('Capital', c.capital),
      stat('Local time', localTime(c.tz)),
      stat('Population', c.pop ? c.pop.toLocaleString() : null),
      stat('Area', c.areaKm2 ? `${c.areaKm2.toLocaleString()} km²` : null),
      stat('Currency', c.currency),
      stat('Languages', languages(c.languages)),
    ].join('');

    const live = $('[data-live]');
    if (!d) {
      live.innerHTML = '<p class="ev-credit">Counting what’s there now…</p>';
    } else if (now) {
      const rows = [
        stat('Events, 7 days', now.events.count),
        now.flights != null && stat('Aircraft overhead', now.flights.toLocaleString()),
        stat('Ships near coast', now.ships ? now.ships.toLocaleString() : null),
        now.radiation && stat('Radiation', `${now.radiation.average.toFixed(2)} µSv/h`),
        now.outage && stat('Internet', now.outage.ongoing ? 'Outage now' : 'Outage in last 2 days'),
      ].filter(Boolean).join('');
      const events = now.events.top.map((e) => `<button class="cp-event" data-event="${esc(e.id)}">${esc(e.title)}</button>`).join('');
      live.innerHTML = `<h4>Right now</h4><dl class="fp-stats">${rows}</dl>${events}`;
    } else {
      live.innerHTML = '';
    }
    const toggle = $('[data-flag-toggle]');
    toggle.hidden = !c.iso;
    toggle.textContent = settings.hidden.includes(c.id) ? 'Show flag' : 'Hide flag';
    $('[data-source]').innerHTML = d?.wiki?.url
      ? `Summary: <a href="${esc(d.wiki.url)}" target="_blank" rel="noopener">Wikipedia</a> · Facts: GeoNames`
      : 'Facts: GeoNames';
  }

  function zoomTo(c) {
    const main = c.pieces.reduce((a, b) => (b.area > a.area ? b : a));
    const lons = main.rings[0].map((p) => p[0]);
    const lats = main.rings[0].map((p) => p[1]);
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 90, maxZoom: 6.5, duration: 1500 });
  }

  async function select(id, { fly = false } = {}) {
    clearInterval(clock);
    if (!id) {
      sel = null;
      panelEl.hidden = true;
      drawOutline();
      return;
    }
    await load();
    const country = countries.get(id);
    if (!country) return;
    const mine = { id, country, detail: null };
    sel = mine;
    onSelect?.();
    renderPanel();
    drawOutline();
    if (fly) zoomTo(country);
    clock = setInterval(() => { if (sel) renderPanel(); }, 30_000);
    try {
      const res = await fetch(`/api/countries/${encodeURIComponent(id)}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (sel === mine) { mine.detail = d; renderPanel(); }
    } catch (err) {
      console.warn('Country details failed:', err.message);
      if (sel === mine) { mine.detail = {}; renderPanel(); }
    }
  }

  // --- Layer controls --------------------------------------------------------------

  function renderExtra() {
    if (!extraEl.firstElementChild) {
      extraEl.innerHTML = `
        <label class="sub-row">
          <input type="checkbox" data-show>
          <span class="layer-name">Show flags</span>
        </label>
        <label class="cp-opacity">
          <span>Opacity</span>
          <input type="range" min="10" max="100" step="5" data-opacity aria-label="Flag opacity">
          <span class="sub-count" data-opacity-value></span>
        </label>
        <details class="cp-pick">
          <summary>Choose countries</summary>
          <input type="search" placeholder="Filter…" data-filter aria-label="Filter countries">
          <div class="cp-pick-all">
            <button type="button" class="fp-btn" data-all>All</button>
            <button type="button" class="fp-btn" data-none>None</button>
          </div>
          <div class="cp-list" data-list></div>
        </details>
        <p class="ev-hint">Click a country for its summary and what’s happening there. Borders are Natural Earth’s, drawn as they are on the ground, not as an official position.</p>`;
      extraEl.onchange = (e) => {
        if ('show' in e.target.dataset) {
          settings.flags = e.target.checked;
          save();
          showFlags(enabled && settings.flags);
        } else if (e.target.dataset.country) {
          const { country: id } = e.target.dataset;
          settings.hidden = settings.hidden.filter((h) => h !== id);
          if (!e.target.checked) settings.hidden.push(id);
          save();
          redrawFlags();
        }
      };
      extraEl.oninput = (e) => {
        if ('opacity' in e.target.dataset) {
          settings.opacity = Number(e.target.value) / 100;
          save();
          if (map.getLayer('flags')) map.setPaintProperty('flags', 'raster-opacity', settings.opacity);
          extraEl.querySelector('[data-opacity-value]').textContent = `${e.target.value}%`;
        } else if ('filter' in e.target.dataset) {
          renderList();
        }
      };
      extraEl.querySelector('[data-all]').onclick = () => setAll(true);
      extraEl.querySelector('[data-none]').onclick = () => setAll(false);
    }
    extraEl.querySelector('[data-show]').checked = settings.flags;
    extraEl.querySelector('[data-opacity]').value = Math.round(settings.opacity * 100);
    extraEl.querySelector('[data-opacity-value]').textContent = `${Math.round(settings.opacity * 100)}%`;
    renderList();
  }

  function renderList() {
    if (!countries) return;
    const q = extraEl.querySelector('[data-filter]').value.trim().toLowerCase();
    extraEl.querySelector('[data-list]').innerHTML = [...countries.values()]
      .filter((c) => c.iso && (!q || c.name.toLowerCase().includes(q)))
      .map((c) => `<label class="sub-row">
        <input type="checkbox" data-country="${c.id}" ${settings.hidden.includes(c.id) ? '' : 'checked'}>
        <span class="layer-name">${esc(c.name)}</span>
      </label>`).join('');
  }

  function setAll(on) {
    settings.hidden = on ? [] : [...countries.values()].filter((c) => c.iso).map((c) => c.id);
    save();
    renderList();
    redrawFlags();
  }

  // --- Wiring ----------------------------------------------------------------------

  panelEl.querySelector('[data-close]').addEventListener('click', () => select(null));
  panelEl.querySelector('[data-zoom]').addEventListener('click', () => sel && zoomTo(sel.country));
  panelEl.querySelector('[data-flag-toggle]').addEventListener('click', () => {
    if (!sel) return;
    const { id } = sel;
    const hidden = settings.hidden.includes(id);
    settings.hidden = settings.hidden.filter((h) => h !== id);
    if (!hidden) settings.hidden.push(id);
    save();
    renderList();
    renderPanel();
    redrawFlags();
  });
  panelEl.addEventListener('click', (e) => {
    const id = e.target.closest('[data-event]')?.dataset.event;
    if (id) onOpen({ type: 'event', id });
  });
  map.on('click', (e) => {
    if (!enabled || !countries || overlay.pick(e.point)) return;
    const hit = countryAt(e.lngLat.wrap().lng, e.lngLat.lat);
    if (hit && hit.id !== sel?.id) select(hit.id);
    else if (sel) select(null);
  });

  return {
    select,
    focus: (id, { fly = true } = {}) => select(id, { fly }),
    selected: () => sel?.id ?? null,
    deselect: () => { if (sel) select(null); },
    setTheme() {
      accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || accent;
      if (map.getLayer('country-sel-line')) {
        map.setPaintProperty('country-sel-fill', 'fill-color', accent);
        map.setPaintProperty('country-sel-line', 'line-color', accent);
      }
    },
    async setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      extraEl.hidden = !on;
      if (on) {
        renderExtra();
        try {
          await load();
        } catch (err) {
          onStatus(`Countries failed to load: ${err.message}`);
          return;
        }
      }
      showFlags(enabled && settings.flags);
      if (!on) select(null);
    },
  };
}
