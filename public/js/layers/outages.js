// Internet outages: countries IODA flagged in the last two days, with a chart of how
// each signal moved. Data via server/sources/outages.js.

import { badgeAtlas, badgeSvg, circle, ROUND } from '../badges.js';
import * as geo from '../geo.js';
import { esc } from './flight-panel.js';

const REFRESH_MS = 10 * 60_000;
const PICK_LAYERS = ['outages:marks'];
const ON_TOP = { cullMode: 'none', depthCompare: 'always', depthWriteEnabled: false };
const SIZE = 24;

const SIGNAL = { fill: circle(12, 17.6, 1.5), stroke: 'M4.800 10.200a10.200 10.200 0 0 1 14.400 0M8 13.600a5.700 5.700 0 0 1 8 0M5 5l14 14' };
const KINDS = [
  { id: 'ongoing', name: 'Ongoing', color: '#ff5470', shape: ROUND, ...SIGNAL },
  { id: 'ended', name: 'Ended', color: '#ffb454', shape: ROUND, ...SIGNAL },
];
const kindOf = (o) => (o.ongoing ? 'ongoing' : 'ended');

function ago(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} min`;
  const hours = ms / 3600_000;
  return hours < 36 ? `${Math.round(hours)} h` : `${Math.round(hours / 24)} days`;
}

// One signal over the two days. It starts from zero, so a real drop looks like one.
function signalChart(s) {
  const known = s.values.filter(Number.isFinite);
  if (known.length < 2) return '';
  const top = Math.max(...known) || 1;
  const points = s.values
    .map((v, i) => (Number.isFinite(v) ? `${((i / (s.values.length - 1)) * 100).toFixed(1)},${(30 - (v / top) * 28).toFixed(1)}` : null))
    .filter(Boolean).join(' ');
  return `
    <div class="out-signal">
      <h4>${esc(s.name)}</h4>
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label="${esc(s.name)} over the last two days">
        <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
      </svg>
    </div>`;
}

export function createOutages({ map, overlay, panelEl, extraEl, settings, save, onCount, onStatus, onSelect }) {
  const atlas = badgeAtlas(KINDS);
  let enabled = false;
  let outages = [];
  let raf = 0;
  let timer = 0;
  let loading = null;
  let sel = null; // { id, row, detail, error }

  overlay.tooltip('outages', (o) => (o?.id
    ? `<b>${esc(o.name)}</b><br>${o.ongoing ? 'Internet outage now' : `Outage ended ${ago(Date.now() - o.end)} ago`}`
    : null));

  const shown = () => outages.filter((o) => !settings.hidden.includes(kindOf(o)));

  async function load() {
    try {
      const res = await fetch('/api/outages');
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (!enabled) return;
      outages = d.outages;
      report();
      requestDraw();
    } catch (err) {
      console.error(err);
      onStatus(`Internet outages failed to load: ${err.message}`);
    }
  }

  function report() {
    const n = shown().length;
    const now = outages.filter((o) => o.ongoing).length;
    onCount(n);
    onStatus(`📡 ${now ? `${now} internet outage${now === 1 ? '' : 's'} now` : 'No internet outages now'}`);
    renderExtra();
  }

  function requestDraw() {
    if (enabled && !raf) raf = requestAnimationFrame(draw);
  }

  function draw() {
    raf = 0;
    if (!enabled) return;
    const hidden = geo.globeOccluder(map, Infinity);
    const visible = hidden ? shown().filter((o) => !hidden([o.lon, o.lat])) : shown();
    const layers = [new deck.IconLayer({
      id: 'outages:marks',
      // Ongoing last, so they draw on top.
      data: [...visible].sort((a, b) => a.ongoing - b.ongoing),
      iconAtlas: atlas.canvas,
      iconMapping: atlas.mapping,
      getIcon: kindOf,
      getPosition: (o) => [o.lon, o.lat],
      getSize: SIZE,
      sizeUnits: 'pixels',
      billboard: true,
      pickable: true,
      parameters: ON_TOP,
    })];
    const at = sel?.row;
    if (at && !hidden?.([at.lon, at.lat])) {
      layers.push(new deck.ScatterplotLayer({
        id: 'outages:selected',
        data: [at],
        getPosition: (o) => [o.lon, o.lat],
        getRadius: SIZE * 0.7,
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
    overlay.set('outages', layers);
  }

  async function select(id) {
    if (!id) {
      sel = null;
      panelEl.hidden = true;
      requestDraw();
      return;
    }
    await loading;
    sel = { id, row: outages.find((o) => o.id === id) || null };
    onSelect?.();
    renderPanel();
    requestDraw();
    try {
      const res = await fetch(`/api/outages/${encodeURIComponent(id)}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (sel?.id !== id) return;
      sel.detail = d;
      sel.row = d;
    } catch (err) {
      console.error(err);
      if (sel?.id !== id) return;
      sel.error = err.message;
    }
    renderPanel();
    requestDraw();
  }

  function renderPanel() {
    const $ = (q) => panelEl.querySelector(q);
    const o = sel.row;
    panelEl.hidden = false;
    $('[data-name]').textContent = o?.name || 'Internet outage';
    $('[data-kind]').textContent = !o ? '' : o.ongoing ? 'Internet outage now' : `Internet outage, ended ${ago(Date.now() - o.end)} ago`;
    $('[data-source]').innerHTML = `Data: <a href="https://ioda.inetintel.cc.gatech.edu/country/${esc(sel.id)}" target="_blank" rel="noopener">IODA, Georgia Tech</a>`;
    if (!o) {
      $('[data-body]').innerHTML = sel.error ? '<p class="fp-warn">This outage is no longer listed.</p>' : '';
      return;
    }
    const stat = (label, value) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
    const time = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    $('[data-body]').innerHTML = `
      <dl class="fp-stats">
        ${stat('Started, UTC', time(o.start))}
        ${stat(o.ongoing ? 'Running for' : 'Lasted', ago((o.ongoing ? Date.now() : o.end) - o.start))}
        <div class="wide"><dt>Seen in</dt><dd>${esc(o.signals.join(', '))}</dd></div>
      </dl>
      ${sel.detail?.series.map(signalChart).join('') || ''}
      <p class="ev-credit">A drop can mean a network changed its routes, not that people lost access. Times can span several separate drops.</p>`;
  }

  function renderExtra() {
    if (!extraEl.firstElementChild) {
      extraEl.innerHTML = `${KINDS.map((k) => `
        <label class="sub-row">
          <input type="checkbox" data-kind="${k.id}">
          ${badgeSvg(k)}
          <span class="layer-name">${k.name}</span><span class="radio-count" data-count="${k.id}"></span>
        </label>`).join('')}
        <p class="ev-hint">Last 48 hours, from <a href="https://ioda.inetintel.cc.gatech.edu/" target="_blank" rel="noopener">IODA</a>. Countries only, and only drops seen in routing, probing or telescope data.</p>`;
      extraEl.addEventListener('change', (e) => {
        const { kind } = e.target.dataset;
        if (!kind) return;
        settings.hidden = e.target.checked ? settings.hidden.filter((k) => k !== kind) : [...settings.hidden, kind];
        save();
        report();
        requestDraw();
      });
    }
    for (const k of KINDS) {
      extraEl.querySelector(`[data-kind="${k.id}"]`).checked = !settings.hidden.includes(k.id);
      extraEl.querySelector(`[data-count="${k.id}"]`).textContent = outages.filter((o) => kindOf(o) === k.id).length;
    }
  }

  panelEl.querySelector('[data-close]').addEventListener('click', () => select(null));
  map.on('move', () => {
    if (enabled && geo.globeOccluder(map, Infinity)) requestDraw();
  });
  map.on('click', (e) => {
    if (!enabled) return;
    const info = overlay.pick(e.point, PICK_LAYERS);
    if (info?.object?.id) select(info.object.id);
    else if (sel && !overlay.pick(e.point)) select(null);
  });

  return {
    select,
    focus: (id) => select(String(id)),
    selected: () => sel?.id ?? null,
    deselect: () => { if (sel) select(null); },
    setTheme() { /* fixed, meaningful colors in every theme */ },
    setEnabled(on) {
      if (on === enabled) return loading;
      enabled = on;
      extraEl.hidden = !on;
      clearInterval(timer);
      if (!on) {
        cancelAnimationFrame(raf);
        raf = 0;
        select(null);
        overlay.set('outages', []);
        onCount(null);
        onStatus('');
        return undefined;
      }
      renderExtra();
      onStatus('📡 Loading internet outages…');
      loading = load();
      timer = setInterval(load, REFRESH_MS);
      return loading;
    },
  };
}
