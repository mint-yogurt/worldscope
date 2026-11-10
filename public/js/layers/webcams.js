// Webcams: cameras in the current view. Zooming in shows more, because Windy only
// lists the top of each area. Click one to watch it. Cameras that would overlap join
// into a count badge, which zooms in when clicked.
//
// Data via our server (server/sources/webcams.js): Windy, Digitraffic (Finland),
// Caltrans (California). Windy cameras use Windy's own player, as their terms ask.
// Road cameras are still images, refreshed while the panel is open.

import { badgeAtlas, badgeSvg, countLayer, pillIcon, SQUARE } from '../badges.js';
import { clusterPoints, zoomToCluster } from '../cluster.js';
import * as geo from '../geo.js';
import { esc } from './flight-panel.js';

const GROUPS = [
  { id: 'windy', name: 'Worldwide (Windy)', color: '#4fd1ff' },
  { id: 'road', name: 'Road cameras', color: '#ffd166' },
];
const groupOf = (src) => (src === 'windy' ? 'windy' : 'road');
const CREDIT = {
  windy: 'Webcam from <a href="https://www.windy.com/webcams" target="_blank" rel="noopener">Windy.com</a>',
  fi: 'Source: <a href="https://www.digitraffic.fi/en/road-traffic/" target="_blank" rel="noopener">Fintraffic / Digitraffic</a> (CC BY 4.0)',
  ca: 'Source: <a href="https://cwwp2.dot.ca.gov/" target="_blank" rel="noopener">Caltrans</a>',
};
const IMAGE_EVERY_MS = 60_000;
const PICK_LAYERS = ['webcams:cams'];
const ON_TOP = { cullMode: 'none', depthCompare: 'always', depthWriteEnabled: false };

const CAMERA = 'M6.5 7.500h6.500a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H6.500a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2zM15.500 11 20 8v8l-4.500-3z';
const KINDS = GROUPS.map((g) => ({ id: g.id, color: g.color, shape: SQUARE, fill: CAMERA }));
const CLUSTER_RADIUS_PX = 36;
const CLUSTER_MAX_ZOOM = 14; // cameras closer than this are on the same mast
const RETRY_MS = 70_000; // a little longer than the server waits after a rate limit
const PENDING_MS = 3000; // the server is still fetching Windy cells for this view

// The group with the most cameras colors a cluster.
function clusterGroup(members) {
  const windy = members.filter((c) => c.group === 'windy').length;
  return windy * 2 >= members.length ? 'windy' : 'road';
}

export function createWebcams({ map, overlay, panelEl, extraEl, settings, save, onCount, onStatus, onSelect }) {
  const atlas = badgeAtlas(KINDS);
  let enabled = false;
  let cams = [];
  let windyTotal = 0;
  let sources = [];
  let raf = 0;
  let loadToken = 0;
  let fetched = null;
  let sel = null; // { id, detail, view, error }
  let dataStamp = 0; // changes with the cameras or filters, to redo the clusters
  let marks = { key: '', items: [] };
  let imageTimer = 0;
  let retryTimer = 0;

  overlay.tooltip('webcams', (c) => {
    if (c?.members) return `<b>${c.members.length.toLocaleString()} webcams</b><br>Click to zoom in`;
    return c?.id ? `<b>${esc(c.name)}</b>` : null;
  });

  // --- Data ------------------------------------------------------------------------

  function viewBbox() {
    if (map.getZoom() < 4) return [-180, -90, 180, 90];
    const b = map.getBounds();
    const padX = (b.getEast() - b.getWest()) * 0.2;
    const padY = (b.getNorth() - b.getSouth()) * 0.2;
    return [b.getWest() - padX, Math.max(-90, b.getSouth() - padY), b.getEast() + padX, Math.min(90, b.getNorth() + padY)];
  }

  async function load() {
    const bbox = viewBbox();
    const zoom = Math.round(map.getZoom());
    const key = `${bbox.map((v) => v.toFixed(2))}|${zoom}`;
    if (key === fetched) return;
    fetched = key;
    const token = ++loadToken;
    try {
      const res = await fetch(`/api/webcams?bbox=${bbox.map((v) => v.toFixed(3)).join(',')}&zoom=${zoom}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (token !== loadToken || !enabled) return;
      cams = d.webcams.map(([id, src, name, lon, lat]) => ({ id, src, name, lon, lat, group: groupOf(src) }));
      windyTotal = d.windyTotal;
      sources = d.sources;
      dataStamp++;
      report();
      requestDraw();
      // Whatever arrived stays on the map; the rest is asked for again.
      clearTimeout(retryTimer);
      const failing = sources.some((s) => !s.ok);
      if (failing || d.pending) {
        retryTimer = setTimeout(() => {
          fetched = null;
          load();
        }, failing ? RETRY_MS : PENDING_MS);
      }
    } catch (err) {
      console.error(err);
      fetched = null;
      onStatus(`Webcams failed to load: ${err.message}`);
    }
  }

  const shown = () => cams.filter((c) => !settings.hidden.includes(c.group));

  function report() {
    const n = shown().length;
    const down = sources.filter((s) => !s.ok).map((s) => (s.id === 'windy' ? 'Windy' : 'Road cameras'));
    onCount(n);
    onStatus(`📷 ${n.toLocaleString()} webcams${down.length ? ` · ${down.join(', ')} unavailable` : ''}`);
    renderExtra();
  }

  // --- Drawing ---------------------------------------------------------------------

  function requestDraw() {
    if (enabled && !raf) raf = requestAnimationFrame(draw);
  }

  // Singles, then clusters so counts stay readable. Redone at every half zoom level.
  function clustered(zoom) {
    const level = Math.round(zoom * 2) / 2;
    const key = `${dataStamp}|${level}`;
    if (key === marks.key) return marks.items;
    let items = shown();
    if (level < CLUSTER_MAX_ZOOM) {
      const { singles, clusters } = clusterPoints(items, level, CLUSTER_RADIUS_PX);
      for (const c of clusters) c.group = clusterGroup(c.members);
      items = [...singles, ...clusters];
    }
    marks = { key, items };
    return items;
  }

  function draw() {
    raf = 0;
    if (!enabled) return;
    const hidden = geo.globeOccluder(map, Infinity);
    const zoom = map.getZoom();
    const all = clustered(zoom);
    const visible = hidden ? all.filter((c) => !hidden([c.lon, c.lat])) : all;
    const size = zoom < 4 ? 17 : zoom < 8 ? 17 + (zoom - 4) * 1.5 : 23;
    const pillSize = size + 2;
    const layers = [new deck.IconLayer({
      id: 'webcams:cams',
      data: visible,
      iconAtlas: atlas.canvas,
      iconMapping: atlas.mapping,
      getIcon: (c) => (c.members ? pillIcon(c.group, c.members.length) : c.group),
      getPosition: (c) => [c.lon, c.lat],
      getSize: (c) => (c.members ? pillSize : size),
      sizeUnits: 'pixels',
      billboard: true,
      pickable: true,
      parameters: ON_TOP,
      updateTriggers: { getSize: size },
    }), countLayer('webcams:counts', visible.filter((c) => c.members), pillSize, ON_TOP)];
    const at = sel?.detail;
    if (at && !hidden?.([at.lon, at.lat])) {
      // Drawn on its own, so it still shows when its camera is inside a cluster.
      layers.push(new deck.IconLayer({
        id: 'webcams:selected-badge',
        data: [at],
        iconAtlas: atlas.canvas,
        iconMapping: atlas.mapping,
        getIcon: (c) => groupOf(c.src),
        getPosition: (c) => [c.lon, c.lat],
        getSize: size,
        sizeUnits: 'pixels',
        billboard: true,
        parameters: ON_TOP,
      }));
      layers.push(new deck.ScatterplotLayer({
        id: 'webcams:selected',
        data: [at],
        getPosition: (c) => [c.lon, c.lat],
        getRadius: size * 0.7 + 3,
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
    overlay.set('webcams', layers);
  }

  // --- Selection & panel -------------------------------------------------------------

  async function select(id) {
    clearInterval(imageTimer);
    if (!id) {
      sel = null;
      panelEl.hidden = true;
      panelEl.querySelector('[data-view]').replaceChildren(); // stops the player
      requestDraw();
      return;
    }
    const known = cams.find((c) => c.id === id);
    sel = { id, detail: null, name: known?.name, view: 0 };
    onSelect?.();
    renderPanel();
    try {
      const res = await fetch(`/api/webcams/${encodeURIComponent(id)}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (sel?.id !== id) return;
      sel.detail = d;
    } catch (err) {
      console.error(err);
      if (sel?.id !== id) return;
      sel.error = err.message;
    }
    renderPanel();
    requestDraw();
  }

  function showImage(url, alt) {
    const box = panelEl.querySelector('[data-view]');
    const img = document.createElement('img');
    img.alt = alt;
    img.className = 'cam-image';
    img.src = url;
    img.addEventListener('error', () => {
      box.innerHTML = '<p class="fp-warn">This camera isn\'t sending a picture right now.</p>';
      clearInterval(imageTimer);
    });
    box.replaceChildren(img);
    clearInterval(imageTimer);
    imageTimer = setInterval(() => { img.src = `${url}?t=${Date.now()}`; }, IMAGE_EVERY_MS);
  }

  function showPlayer(url, title) {
    const frame = document.createElement('iframe');
    // The page is cross-origin isolated, and this lets another site's frame load inside it.
    frame.credentialless = true;
    frame.className = 'cam-player';
    frame.title = `Webcam player: ${title}`;
    frame.allow = 'fullscreen';
    frame.src = url;
    panelEl.querySelector('[data-view]').replaceChildren(frame);
  }

  function renderPanel() {
    const $ = (q) => panelEl.querySelector(q);
    const d = sel.detail;
    panelEl.hidden = false;
    $('[data-name]').textContent = d?.name || sel.name || 'Loading…';
    $('[data-kind]').textContent = d?.place || '';
    $('[data-views]').innerHTML = '';
    $('[data-source]').innerHTML = '';
    $('[data-actions]').innerHTML = '';
    if (!d) {
      $('[data-view]').innerHTML = sel.error ? '<p class="fp-warn">This camera is no longer listed.</p>' : '';
      return;
    }
    if (d.src === 'windy') {
      if (d.player) showPlayer(d.player, d.name);
      else $('[data-view]').innerHTML = '<p class="fp-warn">No player for this camera.</p>';
      $('[data-actions]').innerHTML = `<a class="fp-btn" href="${esc(d.url)}" target="_blank" rel="noopener">Open on Windy</a>`;
    } else if (d.views.length) {
      const view = d.views[sel.view] || d.views[0];
      showImage(view.image, view.name);
      if (d.views.length > 1) {
        $('[data-views]').innerHTML = d.views.map((v, i) => `
          <button class="fp-btn" data-pick-view="${i}" aria-pressed="${i === sel.view}">${esc(v.name)}</button>`).join('');
      }
    } else {
      $('[data-view]').innerHTML = '<p class="fp-warn">This camera isn\'t sending a picture right now.</p>';
    }
    $('[data-source]').innerHTML = CREDIT[d.src];
  }

  // --- Layer controls ----------------------------------------------------------------

  function renderExtra() {
    if (!extraEl.firstElementChild) {
      extraEl.innerHTML = `${GROUPS.map((g) => `
        <label class="sub-row">
          <input type="checkbox" data-group="${g.id}">
          ${badgeSvg(KINDS.find((k) => k.id === g.id))}
          <span class="layer-name">${g.name}</span><span class="radio-count" data-count="${g.id}"></span>
        </label>`).join('')}
        <p class="ev-hint" data-note></p>
        <p class="ev-hint">Webcams provided by <a href="https://www.windy.com/" target="_blank" rel="noopener">windy.com</a> · road cameras by Fintraffic and Caltrans.</p>`;
      extraEl.addEventListener('change', (e) => {
        const { group } = e.target.dataset;
        if (!group) return;
        settings.hidden = e.target.checked ? settings.hidden.filter((g) => g !== group) : [...settings.hidden, group];
        save();
        dataStamp++;
        report();
        requestDraw();
      });
    }
    for (const g of GROUPS) {
      extraEl.querySelector(`[data-group="${g.id}"]`).checked = !settings.hidden.includes(g.id);
      extraEl.querySelector(`[data-count="${g.id}"]`).textContent = cams.filter((c) => c.group === g.id).length.toLocaleString();
    }
    const windyShown = cams.filter((c) => c.group === 'windy').length;
    extraEl.querySelector('[data-note]').textContent = windyTotal > windyShown
      ? `Showing the ${windyShown.toLocaleString()} most viewed of ${windyTotal.toLocaleString()} here. Zoom in for more.`
      : 'Every listed camera in this view.';
  }

  // --- Wiring ------------------------------------------------------------------------

  panelEl.querySelector('[data-close]').addEventListener('click', () => select(null));
  panelEl.addEventListener('click', (e) => {
    const i = e.target.closest('[data-pick-view]')?.dataset.pickView;
    if (i === undefined || !sel) return;
    sel.view = Number(i);
    renderPanel();
  });
  map.on('move', () => {
    if (enabled && geo.globeOccluder(map, Infinity)) requestDraw();
  });
  map.on('zoom', requestDraw);
  map.on('moveend', () => { if (enabled) load(); });
  map.on('click', (e) => {
    if (!enabled) return;
    const info = overlay.pick(e.point, PICK_LAYERS);
    if (info?.object?.members) zoomToCluster(map, info.object);
    else if (info?.object?.id) select(info.object.id);
    else if (sel && !overlay.pick(e.point)) select(null);
  });

  return {
    select,
    focus: (id) => select(String(id)),
    selected: () => sel?.id ?? null,
    deselect: () => { if (sel) select(null); },
    setTheme() { /* fixed, meaningful colors in every theme */ },
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      extraEl.hidden = !on;
      if (!on) {
        cancelAnimationFrame(raf);
        raf = 0;
        fetched = null;
        clearTimeout(retryTimer);
        select(null);
        overlay.set('webcams', []);
        onCount(null);
        onStatus('');
        return;
      }
      renderExtra();
      onStatus('📷 Loading webcams…');
      load();
      requestDraw();
    },
  };
}
