// Rocket launches: the coming weeks and the last two, on their pads. Launches near each
// other join into a count badge. Data via server/sources/launches.js (Launch Library 2).

import { badgeAtlas, badgeSvg, circle, countLayer, pillIcon, ROUND } from '../badges.js';
import { clusterPoints, zoomToCluster } from '../cluster.js';
import * as geo from '../geo.js';
import { esc } from './flight-panel.js';

const REFRESH_MS = 20 * 60_000;
const SOON_MS = 24 * 3600_000;
const PICK_LAYERS = ['launches:marks'];
const ON_TOP = { cullMode: 'none', depthCompare: 'always', depthWriteEnabled: false };
const CLUSTER_RADIUS_PX = 34;
const SAME_SPOT_DEG = 0.003;
const LIST_ZOOM = 12;

const ROCKET = `M19 5Q19 10.09 15.18 13.91L12.64 16.45L7.55 11.36L10.09 8.82Q13.91 5 19 5zM10.73 8.18L6.15 8.69L3.6 11.24L7.16 11.75zM15.82 13.27L15.31 17.85L12.76 20.4L12.25 16.84zM7.93 13.53L10.47 16.07L6.27 17.73z${circle(14.23, 9.77, 1.5)}`;
const KINDS = [
  { id: 'soon', name: 'Next 24 hours', color: '#ff7e5f', shape: ROUND, fill: ROCKET, pillRadius: 11 },
  { id: 'next', name: 'Upcoming', color: '#ffd166', shape: ROUND, fill: ROCKET, pillRadius: 11 },
  { id: 'past', name: 'Last 14 days', color: '#a9b8c9', shape: ROUND, fill: ROCKET, pillRadius: 11 },
];
const kindById = Object.fromEntries(KINDS.map((k) => [k.id, k]));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function kindOf(l, now) {
  if (l.net <= now) return 'past';
  return l.exact && l.net - now < SOON_MS ? 'soon' : 'next';
}

const pad2 = (n) => String(n).padStart(2, '0');

// "T-2d 04:12:33", or "T+…" once it's gone.
function countdown(ms) {
  const s = Math.floor(Math.abs(ms) / 1000);
  const days = Math.floor(s / 86_400);
  const clock = `${pad2(Math.floor(s / 3600) % 24)}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
  return `T${ms > 0 ? '-' : '+'}${days ? `${days}d ` : ''}${clock}`;
}

// As exactly as the launch time is known.
function whenText(l) {
  const d = new Date(l.net);
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (l.exact) return `${day}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
  if (l.precision === 'Day') return `${day}, time not set`;
  if (l.precision === 'Month') return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, date not set`;
  return `${l.precision || 'Sometime'} ${d.getUTCFullYear()}, date not set`;
}

export function createLaunches({ map, overlay, panelEl, extraEl, settings, save, onCount, onStatus, onSelect }) {
  const atlas = badgeAtlas(KINDS);
  let enabled = false;
  let launches = [];
  let raf = 0;
  let timer = 0;
  let tick = 0;
  let loading = null;
  let sel = null; // { id, row }
  let listing = false; // the panel is showing what's at a spot
  let dataStamp = 0;
  let marks = { key: '', items: [] };

  overlay.tooltip('launches', (l) => {
    if (l?.members) return `<b>${l.members.length} launches</b><br>Click to see them`;
    return l?.id ? `<b>${esc(l.name)}</b><br>${esc(whenText(l))}` : null;
  });

  const shown = () => launches.filter((l) => !settings.hidden.includes(l.kind));
  const nextLaunch = () => launches.find((l) => l.net > Date.now());

  async function load() {
    try {
      const res = await fetch('/api/launches');
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (!enabled) return;
      launches = d.launches;
      classify();
      report();
    } catch (err) {
      console.error(err);
      onStatus(`Launches failed to load: ${err.message}`);
    }
  }

  // Launches change group as the clock runs.
  function classify() {
    const now = Date.now();
    let changed = false;
    for (const l of launches) {
      const kind = kindOf(l, now);
      changed ||= kind !== l.kind;
      l.kind = kind;
    }
    if (changed) {
      dataStamp++;
      requestDraw();
    }
    return changed;
  }

  function report() {
    onCount(shown().length);
    const next = nextLaunch();
    onStatus(next ? `🚀 Next: ${next.name}` : '🚀 No launches listed');
    renderExtra();
  }

  function requestDraw() {
    if (enabled && !raf) raf = requestAnimationFrame(draw);
  }

  function clustered(zoom) {
    const level = Math.round(zoom * 2) / 2;
    const key = `${dataStamp}|${level}`;
    if (key === marks.key) return marks.items;
    const { singles, clusters } = clusterPoints(shown(), level, CLUSTER_RADIUS_PX);
    // A cluster shows the soonest thing in it.
    for (const c of clusters) c.kind = KINDS.find((k) => c.members.some((m) => m.kind === k.id)).id;
    marks = { key, items: [...singles, ...clusters] };
    return marks.items;
  }

  function draw() {
    raf = 0;
    if (!enabled) return;
    const hidden = geo.globeOccluder(map, Infinity);
    const zoom = map.getZoom();
    const all = clustered(zoom);
    const visible = hidden ? all.filter((l) => !hidden([l.lon, l.lat])) : all;
    const size = zoom < 4 ? 20 : zoom < 8 ? 20 + (zoom - 4) : 24;
    const pillSize = size + 1;
    const layers = [new deck.IconLayer({
      id: 'launches:marks',
      data: visible,
      iconAtlas: atlas.canvas,
      iconMapping: atlas.mapping,
      getIcon: (l) => (l.members ? pillIcon(l.kind, l.members.length) : l.kind),
      getPosition: (l) => [l.lon, l.lat],
      getSize: (l) => (l.members ? pillSize : size),
      sizeUnits: 'pixels',
      billboard: true,
      pickable: true,
      parameters: ON_TOP,
      updateTriggers: { getSize: size, getIcon: dataStamp },
    }), countLayer('launches:counts', visible.filter((l) => l.members), pillSize, ON_TOP)];
    const at = sel?.row;
    if (at && !hidden?.([at.lon, at.lat])) {
      layers.push(new deck.IconLayer({
        id: 'launches:selected-badge',
        data: [at],
        iconAtlas: atlas.canvas,
        iconMapping: atlas.mapping,
        getIcon: (l) => l.kind,
        getPosition: (l) => [l.lon, l.lat],
        getSize: size,
        sizeUnits: 'pixels',
        billboard: true,
        parameters: ON_TOP,
      }));
      layers.push(new deck.ScatterplotLayer({
        id: 'launches:selected',
        data: [at],
        getPosition: (l) => [l.lon, l.lat],
        getRadius: size * 0.7,
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
    overlay.set('launches', layers);
  }

  async function select(id) {
    listing = false;
    if (!id) {
      sel = null;
      panelEl.hidden = true;
      requestDraw();
      return;
    }
    await loading;
    const row = launches.find((l) => l.id === id);
    if (!row) return;
    sel = { id, row };
    onSelect?.();
    renderPanel();
    requestDraw();
  }

  function openCluster(cluster) {
    const lons = cluster.members.map((m) => m.lon);
    const lats = cluster.members.map((m) => m.lat);
    const span = Math.max(Math.max(...lons) - Math.min(...lons), Math.max(...lats) - Math.min(...lats));
    if (span < SAME_SPOT_DEG || map.getZoom() >= LIST_ZOOM) showList(cluster.members);
    else zoomToCluster(map, cluster);
  }

  function showList(members) {
    const $ = (q) => panelEl.querySelector(q);
    sel = null;
    listing = true;
    onSelect?.();
    panelEl.hidden = false;
    const now = Date.now();
    const list = [...members].sort((a, b) => (b.net > now) - (a.net > now) || (a.net > now ? a.net - b.net : b.net - a.net));
    $('[data-name]').textContent = `${members.length} launches`;
    $('[data-kind]').textContent = members[0].pad || '';
    $('[data-count]').textContent = '';
    $('[data-body]').innerHTML = `<ul class="radio-list">${list.map((m) => `
      <li><button data-open="${esc(m.id)}">${badgeSvg(kindById[m.kind])}<span>${esc(m.name)}</span></button></li>`).join('')}</ul>`;
    $('[data-source]').innerHTML = CREDIT;
    requestDraw();
  }

  const CREDIT = 'Data: <a href="https://thespacedevs.com/llapi" target="_blank" rel="noopener">Launch Library 2</a>';

  function renderCountdown() {
    if (!sel || panelEl.hidden) return;
    const { row } = sel;
    panelEl.querySelector('[data-count]').textContent = row.exact ? countdown(row.net - Date.now()) : '';
  }

  function renderPanel() {
    const $ = (q) => panelEl.querySelector(q);
    const l = sel.row;
    panelEl.hidden = false;
    $('[data-name]').textContent = l.name;
    $('[data-kind]').textContent = l.rocket || '';
    const stat = (label, value) => (value ? `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>` : '');
    const wide = (label, value) => (value ? `<div class="wide"><dt>${label}</dt><dd>${esc(value)}</dd></div>` : '');
    const buttons = [
      l.watch && `<a class="fp-btn" href="${esc(l.watch)}" target="_blank" rel="noopener">${l.live ? 'Watch live' : 'Watch'}</a>`,
      l.info && `<a class="fp-btn" href="${esc(l.info)}" target="_blank" rel="noopener">More</a>`,
    ].filter(Boolean).join('');
    $('[data-body]').innerHTML = `
      <dl class="fp-stats">
        ${wide('When', whenText(l))}
        ${stat('Status', l.statusText)}
        ${stat('Orbit', l.orbit)}
        ${wide('Provider', l.provider)}
        ${wide('Pad', [l.pad, l.site].filter(Boolean).join(', '))}
      </dl>
      ${l.failure ? `<p class="fp-warn">${esc(l.failure)}</p>` : ''}
      ${l.about ? `<p class="ev-summary">${esc(l.about)}</p>` : ''}
      ${buttons ? `<div class="fp-actions">${buttons}</div>` : ''}`;
    $('[data-source]').innerHTML = CREDIT;
    renderCountdown();
  }

  function renderExtra() {
    if (!extraEl.firstElementChild) {
      extraEl.innerHTML = `
        <p class="launch-next" data-next></p>
        ${KINDS.map((k) => `
          <label class="sub-row">
            <input type="checkbox" data-kind="${k.id}">
            ${badgeSvg(k)}
            <span class="layer-name">${k.name}</span><span class="radio-count" data-count="${k.id}"></span>
          </label>`).join('')}
        <p class="ev-hint">From <a href="https://thespacedevs.com/llapi" target="_blank" rel="noopener">Launch Library 2</a>. Dates move often, so check close to launch.</p>`;
      extraEl.addEventListener('change', (e) => {
        const { kind } = e.target.dataset;
        if (!kind) return;
        settings.hidden = e.target.checked ? settings.hidden.filter((k) => k !== kind) : [...settings.hidden, kind];
        save();
        dataStamp++;
        report();
        requestDraw();
      });
    }
    for (const k of KINDS) {
      extraEl.querySelector(`[data-kind="${k.id}"]`).checked = !settings.hidden.includes(k.id);
      extraEl.querySelector(`[data-count="${k.id}"]`).textContent = launches.filter((l) => l.kind === k.id).length;
    }
    renderNext();
  }

  function renderNext() {
    const line = extraEl.querySelector('[data-next]');
    const next = nextLaunch();
    if (!line) return;
    line.hidden = !next;
    if (next) line.innerHTML = `<button data-open="${esc(next.id)}"><b>${next.exact ? countdown(next.net - Date.now()) : esc(whenText(next))}</b><span>${esc(next.name)}</span></button>`;
  }

  // Runs while the layer is on, for the two countdowns.
  function everySecond() {
    if (classify()) report();
    else renderNext();
    renderCountdown();
  }

  const openFromList = (e) => {
    const id = e.target.closest('[data-open]')?.dataset.open;
    if (!id) return;
    const row = launches.find((l) => l.id === id);
    if (row) map.flyTo({ center: [row.lon, row.lat], zoom: Math.max(map.getZoom(), 6), duration: 1500, essential: true });
    select(id);
  };
  panelEl.addEventListener('click', openFromList);
  extraEl.addEventListener('click', openFromList);
  panelEl.querySelector('[data-close]').addEventListener('click', () => select(null));
  map.on('move', () => {
    if (enabled && geo.globeOccluder(map, Infinity)) requestDraw();
  });
  map.on('zoom', requestDraw);
  map.on('click', (e) => {
    if (!enabled) return;
    const info = overlay.pick(e.point, PICK_LAYERS);
    if (info?.object?.members) openCluster(info.object);
    else if (info?.object?.id) select(info.object.id);
    else if ((sel || listing) && !overlay.pick(e.point)) select(null);
  });

  return {
    select,
    focus: (id) => select(String(id)),
    selected: () => sel?.id ?? null,
    deselect: () => { if (sel || listing) select(null); },
    setTheme() { /* fixed, meaningful colors in every theme */ },
    setEnabled(on) {
      if (on === enabled) return loading;
      enabled = on;
      extraEl.hidden = !on;
      clearInterval(timer);
      clearInterval(tick);
      if (!on) {
        cancelAnimationFrame(raf);
        raf = 0;
        select(null);
        overlay.set('launches', []);
        onCount(null);
        onStatus('');
        return undefined;
      }
      renderExtra();
      onStatus('🚀 Loading launches…');
      loading = load();
      timer = setInterval(load, REFRESH_MS);
      tick = setInterval(everySecond, 1000);
      return loading;
    },
  };
}
