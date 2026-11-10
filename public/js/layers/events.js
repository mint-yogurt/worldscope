// World events: markers for what's happening now: news (conflict, protests,
// politics...) and natural disasters. The server collects them from several
// sources into a rolling store; this layer shows a time range of it, filtered
// by kind and severity. Click a marker for details, the day-by-day updates,
// related coverage and, for cyclones, the track and wind zones.

import { THEMES } from '../themes.js';
import * as geo from '../geo.js';
import { esc } from './flight-panel.js';

export const KINDS = [
  { id: 'conflict', name: 'War & attacks', one: 'Armed conflict', group: 'News' },
  { id: 'unrest', name: 'Protests & unrest', one: 'Protests & unrest', group: 'News' },
  { id: 'politics', name: 'Politics & diplomacy', one: 'Politics', group: 'News' },
  { id: 'accident', name: 'Accidents', one: 'Accident / disaster', group: 'News' },
  { id: 'crime', name: 'Law & crime', one: 'Law & crime', group: 'News' },
  { id: 'news', name: 'Other news', one: 'News', group: 'News' },
  { id: 'quake', name: 'Earthquakes', one: 'Earthquake', group: 'Natural hazards' },
  { id: 'cyclone', name: 'Cyclones', one: 'Tropical cyclone', group: 'Natural hazards' },
  { id: 'flood', name: 'Floods', one: 'Flood', group: 'Natural hazards' },
  { id: 'volcano', name: 'Volcanoes', one: 'Volcano', group: 'Natural hazards' },
  { id: 'wildfire', name: 'Wildfires', one: 'Wildfire', group: 'Natural hazards' },
  { id: 'drought', name: 'Droughts', one: 'Drought', group: 'Natural hazards' },
];
const KIND_NAME = Object.fromEntries(KINDS.map((k) => [k.id, k.one]));
const SEVERITY = { 1: 'minor', 2: 'significant', 3: 'major' };
const LEVEL_SEVERITY = { Green: 1, Orange: 2, Red: 3 };
const RANGES = [
  { hours: 24, label: '24 h' },
  { hours: 72, label: '3 d' },
  { hours: 168, label: '7 d' },
  { hours: 720, label: '30 d' },
];
const SIZE = { 1: 22, 2: 28, 3: 36 }; // marker size in px by severity
const CELL = 64; // icon atlas cell, px
const NEW_MS = 6 * 3600_000; // events this fresh pulse
const REFRESH_MS = 2 * 60_000;
const PICK_LAYERS = ['events:markers'];
// Markers sit on the ground, so on the globe the curved surface cuts through
// their flat billboards. Draw them without depth testing instead (the far side
// of the Earth is filtered out separately) so they're never clipped.
const ON_TOP = { cullMode: 'none', depthCompare: 'always', depthWriteEnabled: false };

function ago(ms) {
  const min = Math.max(0, (Date.now() - ms) / 60_000);
  if (min < 60) return `${Math.round(min)} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}
const utcText = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// --- Icons -------------------------------------------------------------------------

// Simple line glyphs per kind, drawn in a 24-unit box centered on 0,0.
function drawGlyph(ctx, kind) {
  ctx.beginPath();
  switch (kind) {
    case 'quake': // seismograph
      ctx.moveTo(-9, 0); ctx.lineTo(-5, 0); ctx.lineTo(-3, -7); ctx.lineTo(0, 8); ctx.lineTo(3, -5); ctx.lineTo(5, 0); ctx.lineTo(9, 0);
      ctx.stroke();
      break;
    case 'cyclone': // eye with two spiral arms
      ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
      ctx.moveTo(0, -3.5); ctx.quadraticCurveTo(-1, -9, 7, -8.5);
      ctx.moveTo(0, 3.5); ctx.quadraticCurveTo(1, 9, -7, 8.5);
      ctx.stroke();
      break;
    case 'flood': // waves
      for (const y of [-5, 0, 5]) {
        ctx.moveTo(-9, y);
        ctx.quadraticCurveTo(-6.75, y - 3, -4.5, y); ctx.quadraticCurveTo(-2.25, y + 3, 0, y);
        ctx.quadraticCurveTo(2.25, y - 3, 4.5, y); ctx.quadraticCurveTo(6.75, y + 3, 9, y);
      }
      ctx.stroke();
      break;
    case 'volcano': // cone with ash puffs
      ctx.moveTo(-9, 8); ctx.lineTo(-3, -2); ctx.lineTo(3, -2); ctx.lineTo(9, 8); ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      for (const [x, y, r] of [[0, -5.5, 1.6], [-3, -8.5, 1.5], [2.5, -9.5, 1.8]]) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
      ctx.fill();
      break;
    case 'wildfire': // flame
      ctx.moveTo(0, -9);
      ctx.bezierCurveTo(4, -4, 7, 0, 6, 4); ctx.bezierCurveTo(5, 8, 2, 9, 0, 9);
      ctx.bezierCurveTo(-2, 9, -5, 8, -6, 4); ctx.bezierCurveTo(-7, 0, -3, -2, -2, -6);
      ctx.bezierCurveTo(-1, -3, 0, -3, 0, -9);
      ctx.fill();
      break;
    case 'drought': // blazing sun
      ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        ctx.moveTo(Math.cos(a) * 6, Math.sin(a) * 6); ctx.lineTo(Math.cos(a) * 9, Math.sin(a) * 9);
      }
      ctx.stroke();
      break;
    case 'conflict': // crosshair
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      for (const [x1, y1, x2, y2] of [[0, -10, 0, -3], [0, 3, 0, 10], [-10, 0, -3, 0], [3, 0, 10, 0]]) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 1.6, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'politics': // columned building
      ctx.moveTo(-9, -3); ctx.lineTo(0, -9); ctx.lineTo(9, -3); ctx.closePath();
      ctx.fill();
      ctx.fillRect(-9, 6, 18, 2.5);
      for (const x of [-6.5, -2.2, 2.2, 6.5]) ctx.fillRect(x - 1, -2, 2, 7.5);
      break;
    case 'accident': // warning triangle
      ctx.moveTo(0, -9); ctx.lineTo(9.5, 8); ctx.lineTo(-9.5, 8); ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.fillRect(-1.2, -3, 2.4, 6);
      ctx.arc(0, 5.5, 1.3, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'crime': // shield
      ctx.moveTo(0, -9); ctx.lineTo(8, -6); ctx.quadraticCurveTo(8, 5, 0, 9.5); ctx.quadraticCurveTo(-8, 5, -8, -6); ctx.closePath();
      ctx.stroke();
      break;
    case 'news': // "i"
      ctx.fillRect(-1.6, -2, 3.2, 10);
      ctx.arc(0, -6, 1.9, 0, Math.PI * 2);
      ctx.fill();
      break;
    default: // "!" for protests and anything without its own glyph
      ctx.fillRect(-1.6, -8, 3.2, 10);
      ctx.arc(0, 6.5, 1.9, 0, Math.PI * 2);
      ctx.fill();
  }
}

function drawBadge(ctx, x, y, kind, color, disc) {
  const c = CELL / 2;
  ctx.save();
  ctx.translate(x + c, y + c);
  ctx.beginPath();
  ctx.arc(0, 0, c - 5, 0, Math.PI * 2);
  ctx.fillStyle = disc;
  ctx.globalAlpha = 0.9;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 4;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.scale(1.55, 1.55);
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.fillStyle = color;
  drawGlyph(ctx, kind);
  ctx.restore();
}

// One atlas with a badge per kind (columns) and severity (rows), in theme colors.
function buildAtlas(palette) {
  const kinds = [...KINDS.map((k) => k.id), 'other'];
  const canvas = document.createElement('canvas');
  canvas.width = CELL * kinds.length;
  canvas.height = CELL * 3;
  const ctx = canvas.getContext('2d');
  const mapping = {};
  kinds.forEach((kind, col) => {
    for (const sev of [1, 2, 3]) {
      drawBadge(ctx, col * CELL, (sev - 1) * CELL, kind, palette[SEVERITY[sev]], palette.disc);
      mapping[`${kind}-${sev}`] = { x: col * CELL, y: (sev - 1) * CELL, width: CELL, height: CELL, mask: false };
    }
  });
  return { canvas, mapping };
}

function badgeUrl(kind, color, disc) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CELL;
  drawBadge(canvas.getContext('2d'), 0, 0, kind, color, disc);
  return canvas.toDataURL();
}

// --- Layer -------------------------------------------------------------------------

export function createEvents({ map, overlay, panelEl, extraEl, settings, save, onCount, onStatus, onSelect }) {
  let enabled = false;
  let events = [];
  let retentionDays = 30;
  let shown = []; // events passing the filters, least severe first so major ones draw on top
  let palette = null;
  let rgb = null;
  let atlas = null;
  let sel = null; // { id, event, detail }
  let raf = 0;
  let refreshTimer = 0;
  let loadToken = 0;
  let loading = null;

  overlay.tooltip('events', (e) => (e?.title
    ? `<b>${esc(e.title)}</b><br>${e.place ? `${esc(e.place.length > 60 ? `${e.place.slice(0, 57)}…` : e.place)}<br>` : ''}${ago(e.start)}`
    : null));

  // --- Data ------------------------------------------------------------------------

  async function load() {
    const token = ++loadToken;
    try {
      const res = await fetch(`/api/events?hours=${settings.hours}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (token !== loadToken || !enabled) return;
      events = d.events;
      retentionDays = d.retentionDays;
      const failing = d.sources.filter((s) => !s.ok).map((s) => s.name);
      applyFilters();
      onStatus(`! ${shown.length} events · ${RANGES.find((r) => r.hours === settings.hours)?.label || ''}${failing.length ? ` · ${failing.join(', ')} unavailable` : ''}`);
    } catch (err) {
      console.error(err);
      onStatus(`Events failed to load: ${err.message}`);
    }
  }

  // Filters store what's hidden, so kinds added later show up by default.
  function passes(e) {
    return !settings.hidden.includes(e.kind) && (settings.minor || e.severity >= 2);
  }

  function applyFilters() {
    shown = events.filter(passes).sort((a, b) => a.severity - b.severity || a.start - b.start);
    if (sel && !events.some((e) => e.id === sel.id)) select(null);
    onCount(shown.length);
    renderFilters();
    requestDraw();
  }

  // --- Drawing ---------------------------------------------------------------------

  function requestDraw() {
    if (enabled && !raf) raf = requestAnimationFrame(draw);
  }

  function draw() {
    raf = 0;
    if (!enabled || !atlas) return;
    const now = Date.now();
    const hidden = geo.globeOccluder(map, Infinity);
    const onScreen = hidden ? shown.filter((e) => !hidden([e.lon, e.lat])) : shown;
    const fresh = onScreen.filter((e) => now - e.start < NEW_MS);
    const layers = [];

    if (sel?.detail?.shape) layers.push(...shapeLayers(sel.detail.shape));

    if (fresh.length) {
      layers.push(new deck.ScatterplotLayer({
        id: 'events:pulse',
        data: fresh,
        getPosition: (e) => [e.lon, e.lat],
        getRadius: (e) => SIZE[e.severity] / 2 + ((now / 1600 + e.lat) % 1) * 26,
        getLineColor: (e) => [...rgb[e.severity], Math.round(230 * (1 - ((now / 1600 + e.lat) % 1)))],
        radiusUnits: 'pixels',
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        stroked: true,
        filled: false,
        billboard: true,
        parameters: ON_TOP,
        updateTriggers: { getRadius: now, getLineColor: now },
      }));
    }

    const selected = sel && onScreen.find((e) => e.id === sel.id);
    if (selected) {
      layers.push(new deck.ScatterplotLayer({
        id: 'events:selected',
        data: [selected],
        getPosition: (e) => [e.lon, e.lat],
        getRadius: (e) => SIZE[e.severity] / 2 + 6,
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
      id: 'events:markers',
      data: selected ? [...onScreen.filter((e) => e !== selected), selected] : onScreen,
      iconAtlas: atlas.canvas,
      iconMapping: atlas.mapping,
      getIcon: (e) => `${atlas.mapping[`${e.kind}-1`] ? e.kind : 'other'}-${e.severity}`,
      getPosition: (e) => [e.lon, e.lat],
      getSize: (e) => SIZE[e.severity],
      sizeUnits: 'pixels',
      billboard: true,
      pickable: true,
      parameters: ON_TOP,
    }));

    overlay.set('events', layers);
    if (fresh.length) requestDraw(); // keep the pulse animating
  }

  // Cyclone track and wind zones, or the affected area, of the selected event.
  function shapeLayers(shape) {
    const layers = [];
    if (shape.areas.length) {
      layers.push(new deck.PolygonLayer({
        id: 'events:areas',
        data: shape.areas,
        getPolygon: (a) => a.polygon,
        getFillColor: (a) => [...rgb[LEVEL_SEVERITY[a.level] || 2], 40],
        getLineColor: (a) => [...rgb[LEVEL_SEVERITY[a.level] || 2], 170],
        getLineWidth: 1,
        lineWidthUnits: 'pixels',
        stroked: true,
        wrapLongitude: true,
      }));
    }
    if (shape.track.length) {
      layers.push(new deck.PathLayer({
        id: 'events:track',
        data: shape.track,
        getPath: (p) => p,
        getColor: [255, 255, 255, 200],
        getWidth: 2,
        widthUnits: 'pixels',
        wrapLongitude: true,
        ...(deck.PathStyleExtension && { extensions: [new deck.PathStyleExtension({ dash: true })], getDashArray: [5, 4] }),
      }));
    }
    return layers;
  }

  // --- Selection & panel -------------------------------------------------------------

  async function select(id) {
    if (!id) {
      sel = null;
      panelEl.hidden = true;
      requestDraw();
      return;
    }
    const event = events.find((e) => e.id === id);
    if (!event) return;
    sel = { id, event, detail: null, related: null };
    onSelect?.();
    renderPanel();
    requestDraw();
    loadRelated(id);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(id)}`);
      const detail = await res.json();
      if (!res.ok) throw new Error(detail.error || `HTTP ${res.status}`);
      if (sel?.id !== id) return;
      sel.detail = detail;
      renderPanel();
      requestDraw();
    } catch (err) {
      if (sel?.id === id) panelEl.querySelector('[data-source]').textContent = `Details unavailable: ${err.message}`;
    }
  }

  // News articles about the event (GDELT). Best-effort: it's often rate-limited.
  async function loadRelated(id) {
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(id)}/related`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (sel?.id === id) sel.related = d.articles;
    } catch {
      if (sel?.id === id) sel.related = [];
    }
    if (sel?.id === id) renderRelated();
  }

  function renderRelated() {
    const el = panelEl.querySelector('[data-related]');
    if (!sel.related) {
      el.hidden = false;
      el.innerHTML = '<p class="ev-credit">Looking for related coverage…</p>';
      return;
    }
    const list = sel.related;
    el.hidden = !list.length;
    el.innerHTML = list.length ? `<h4>Related coverage</h4>${list.map((a) => `
      <a class="ev-article" href="${esc(a.url)}" target="_blank" rel="noopener">
        ${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
        <span><b>${esc(a.title)}</b><small>${esc(a.domain)}</small></span>
      </a>`).join('')}<p class="ev-credit">Matched automatically by GDELT; may include loosely related stories.</p>` : '';
  }

  function renderPanel() {
    const e = sel.detail || sel.event;
    const d = sel.detail?.data || {};
    const news = e.source === 'wiki';
    const $ = (q) => panelEl.querySelector(q);
    const stat = (label, value, wide) => (value == null || value === '' ? '' : `<div${wide ? ' class="wide"' : ''}><dt>${label}</dt><dd title="${esc(String(value).replace(/<[^>]+>/g, ''))}">${value}</dd></div>`);
    const fmt = (n, digits = 0) => n.toLocaleString(undefined, { maximumFractionDigits: digits });
    const day = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    panelEl.hidden = false;
    $('[data-title]').textContent = e.title;
    $('[data-kind]').innerHTML =
      `<span class="ev-sev" style="--sev:${palette[SEVERITY[e.severity]]}">${SEVERITY[e.severity]}</span> ${esc(KIND_NAME[e.kind] || e.kind)}`;
    $('[data-place]').textContent = e.place || '';
    $('[data-place]').hidden = !e.place;

    const photo = $('[data-photo]');
    photo.hidden = !d.image;
    if (d.image && photo.querySelector('img').getAttribute('src') !== d.image) photo.querySelector('img').src = d.image;
    const topics = d.topics || [];
    $('[data-topics]').hidden = topics.length < 2;
    $('[data-topics]').innerHTML = topics.map((t) => `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.label)}</a>`).join(' › ');

    const ended = e.end && e.end !== e.start;
    const updates = d.updates || [];
    $('[data-stats]').innerHTML = (news ? [
      stat('First reported', `<span title="${utcText(e.start)}">${ago(e.start)}</span>`),
      updates[0] && stat('Latest update', day(updates[0].day)),
      d.deaths && stat('Reported deaths', `${fmt(d.deaths)}+`),
      stat('Location', `${e.lat.toFixed(2)}°, ${e.lon.toFixed(2)}°`),
    ] : [
      stat(e.kind === 'quake' ? 'Time' : 'Started', `<span title="${utcText(e.start)}">${ago(e.start)}</span>`),
      e.kind !== 'quake' && stat('Status', ended ? `Ended ${ago(e.end)}` : 'Ongoing'),
      d.magnitude != null && stat('Magnitude', `${fmt(d.magnitude, 1)} ${esc(d.magType || '')}`),
      d.depthKm != null && stat('Depth', `${fmt(d.depthKm)} km`),
      d.windKmh && stat('Max wind', `${fmt(d.windKmh)} km/h · ${fmt(d.windKmh / 1.609)} mph`),
      d.acres && stat('Area burned', `${fmt(d.acres)} acres · ${fmt(d.acres * 0.004047)} km²`),
      d.alert && stat(e.source === 'usgs' ? 'Impact alert' : 'Alert level', esc(d.alert[0].toUpperCase() + d.alert.slice(1))),
      d.tsunami && stat('Tsunami', 'Warning info issued'),
      d.felt && stat('Felt reports', fmt(d.felt)),
      stat('Location', `${e.lat.toFixed(2)}°, ${e.lon.toFixed(2)}°`),
      d.severityText && !d.windKmh && stat('Impact', esc(d.severityText), true),
    ]).filter(Boolean).join('');
    // News shows its day-by-day updates instead of a single summary.
    $('[data-summary]').textContent = e.summary || '';
    $('[data-summary]').hidden = !e.summary || updates.length > 0;
    $('[data-updates]').hidden = !updates.length;
    $('[data-updates]').innerHTML = updates.map((u) => `
      <li><time>${day(u.day)}</time>${esc(u.text)}
        ${u.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>`).join(' ')}</li>`).join('');
    renderRelated();
    // News cites its outlets per update; the footer just credits Wikipedia.
    const sources = (d.sources || []).filter((s) => !news || s.name === 'Wikipedia');
    $('[data-source]').innerHTML = sources.length
      ? `Source: ${sources.map((s) => (s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name))).join(' · ')}`
      : sel.detail ? '' : 'Loading details…';
  }

  function zoomToSelected() {
    if (!sel) return;
    const e = sel.event;
    const shape = sel.detail?.shape;
    const coords = shape ? [...shape.track.flat(), ...shape.areas.flatMap((a) => a.polygon.flat())] : [];
    if (coords.length) {
      const lons = coords.map((c) => c[0]);
      const lats = coords.map((c) => c[1]);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 80, maxZoom: 7, duration: 1500 });
    } else {
      map.flyTo({ center: [e.lon, e.lat], zoom: Math.max(map.getZoom(), 6), duration: 1500 });
    }
  }

  // --- Filters -----------------------------------------------------------------------

  function buildFilters() {
    extraEl.innerHTML = `
      <div class="segmented ev-ranges" role="radiogroup" aria-label="Time range" data-ranges></div>
      <div data-kinds></div>
      <p class="ev-hint">News is placed at the most specific place it mentions, so treat locations as approximate.</p>
      <label class="sub-row">
        <input type="checkbox" data-minor>
        <span class="layer-name">Include minor events</span>
        <span class="sub-count" data-minor-count></span>
      </label>
      <div class="ev-legend" data-legend></div>`;
    extraEl.querySelector('[data-kinds]').innerHTML = KINDS.map((k, i) => `
      ${k.group !== KINDS[i - 1]?.group ? `<h4 class="ev-group">${k.group}</h4>` : ''}
      <label class="sub-row">
        <input type="checkbox" data-kind="${k.id}">
        <img class="ev-glyph" data-glyph="${k.id}" alt="">
        <span class="layer-name">${k.name}</span>
        <span class="sub-count" data-count="${k.id}"></span>
      </label>`).join('');
    extraEl.onchange = (e) => {
      if (e.target.dataset.kind) {
        settings.hidden = KINDS.map((k) => k.id).filter((id) => !extraEl.querySelector(`[data-kind="${id}"]`).checked);
      } else if ('minor' in e.target.dataset) {
        settings.minor = e.target.checked;
      } else return;
      save();
      applyFilters();
    };
    extraEl.querySelector('[data-ranges]').onclick = (e) => {
      const hours = Number(e.target.dataset.hours);
      if (!hours || hours === settings.hours) return;
      settings.hours = hours;
      save();
      renderFilters();
      load();
    };
  }

  function renderFilters() {
    if (!extraEl.firstElementChild) buildFilters();
    extraEl.querySelector('[data-ranges]').innerHTML = RANGES
      .filter((r) => r.hours <= retentionDays * 24 || r.hours === RANGES[0].hours)
      .map((r) => `<button role="radio" data-hours="${r.hours}" aria-checked="${r.hours === settings.hours}">${r.label}</button>`).join('');
    const counts = {};
    let minor = 0;
    for (const e of events) {
      if (e.severity < 2) minor++;
      if (settings.minor || e.severity >= 2) counts[e.kind] = (counts[e.kind] || 0) + 1;
    }
    for (const k of KINDS) {
      extraEl.querySelector(`[data-kind="${k.id}"]`).checked = !settings.hidden.includes(k.id);
      extraEl.querySelector(`[data-count="${k.id}"]`).textContent = counts[k.id] || 0;
    }
    extraEl.querySelector('[data-minor]').checked = settings.minor;
    extraEl.querySelector('[data-minor-count]').textContent = `+${minor}`;
    paintIcons();
  }

  function paintIcons() {
    if (!palette || !extraEl.firstElementChild) return;
    for (const img of extraEl.querySelectorAll('[data-glyph]')) {
      img.src = badgeUrl(img.dataset.glyph, palette.significant, palette.disc);
    }
    extraEl.querySelector('[data-legend]').innerHTML = [3, 2, 1]
      .map((s) => `<span><i style="background:${palette[SEVERITY[s]]}"></i>${SEVERITY[s]}</span>`).join('');
  }

  // --- Wiring ------------------------------------------------------------------------

  panelEl.querySelector('[data-close]').addEventListener('click', () => select(null));
  panelEl.querySelector('[data-zoom]').addEventListener('click', zoomToSelected);
  map.on('move', requestDraw);
  map.on('click', (e) => {
    if (!enabled) return;
    const info = overlay.pick(e.point, PICK_LAYERS);
    if (info?.object?.id) select(info.object.id);
    else if (sel && !overlay.pick(e.point)) select(null);
  });

  return {
    select,
    // The event may be older than the time range on show, so widen it if needed.
    async focus(id) {
      await loading;
      if (!events.some((e) => e.id === id)) {
        settings.hours = RANGES.at(-1).hours;
        save();
        renderFilters();
        await load();
      }
      select(id);
    },
    selected: () => sel?.id ?? null,
    deselect: () => { if (sel) select(null); },
    setTheme(id) {
      palette = THEMES[id].events;
      rgb = Object.fromEntries([1, 2, 3].map((s) => [s, geo.hexToRgb(palette[SEVERITY[s]])]));
      atlas = buildAtlas(palette);
      paintIcons();
      if (sel) renderPanel();
      requestDraw();
    },
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      extraEl.hidden = !on;
      clearInterval(refreshTimer);
      if (!on) {
        cancelAnimationFrame(raf);
        raf = 0;
        select(null);
        overlay.set('events', []);
        onCount(null);
        onStatus('');
        return;
      }
      renderFilters();
      onStatus('! Loading events…');
      loading = load();
      refreshTimer = setInterval(load, REFRESH_MS);
    },
  };
}
