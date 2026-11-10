// Radio: receivers you can open and tune, internet stations you can play here,
// and shortwave paths (WSPR) showing where signals are getting through right now.
// Colors are fixed in every theme: they stand for receiver types and radio bands.
// Receivers and stations that would overlap join into a count badge. Clicking one
// zooms in, or lists what's there when they share a spot, as a city's stations often do.
//
// Data via our server (server/sources/radio.js): Receiverbook, the KiwiSDR list,
// Radio Browser and wspr.live.

import { badgeAtlas, badgeSvg, circle, countLayer, pillIcon, ROUND } from '../badges.js';
import { clusterPoints, zoomToCluster } from '../cluster.js';
import * as geo from '../geo.js';
import { esc } from './flight-panel.js';

// Symbols for the round badges: a radio mast to tune, a music note to listen to.
const TOWER = {
  fill: circle(12, 8.5, 1.8),
  stroke: 'M12 10.500 8.500 19M12 10.500 15.500 19M9.800 16h4.400M8.500 11a4.500 4.500 0 0 1 0-5M15.500 11a4.500 4.500 0 0 0 0-5',
};
const NOTE = {
  fill: circle(8, 16.5, 2.3) + circle(15, 15, 2.3),
  stroke: 'M10 16.500V7l7-1.500V15',
};
const round = { shape: ROUND, pillRadius: 11 };
const KINDS = [
  { id: 'KiwiSDR', color: '#4fd1ff', ...round, ...TOWER },
  { id: 'OpenWebRX', color: '#7ee787', ...round, ...TOWER },
  { id: 'WebSDR', color: '#ffd166', ...round, ...TOWER },
  { id: 'station', color: '#ff7eb6', ...round, ...NOTE },
];
const kindOf = (id) => KINDS.find((k) => k.id === id);
const RECEIVER_TYPES = KINDS.filter((k) => k.id !== 'station');
const BANDS = [
  { mhz: 1, name: '160 m', color: '#ff4d4d' },
  { mhz: 3, name: '80 m', color: '#ff8a3d' },
  { mhz: 5, name: '60 m', color: '#ffc23d' },
  { mhz: 7, name: '40 m', color: '#e4e84a' },
  { mhz: 10, name: '30 m', color: '#8fe04a' },
  { mhz: 14, name: '20 m', color: '#3fdc84' },
  { mhz: 18, name: '17 m', color: '#35dcc8' },
  { mhz: 21, name: '15 m', color: '#45b4ff' },
  { mhz: 24, name: '12 m', color: '#6f8cff' },
  { mhz: 28, name: '10 m', color: '#a06bff' },
  { mhz: 50, name: '6 m', color: '#e06bff' },
];
const BAND_BY_MHZ = new Map(BANDS.map((b) => [b.mhz, { ...b, rgb: geo.hexToRgb(b.color) }]));

const PATHS_EVERY_MS = 3 * 60_000;
const SITES_EVERY_MS = 30 * 60_000;
const FLAT_ZOOM = 4.5;
const PICK_LAYERS = ['radio:marks'];
const CLUSTER_RADIUS_PX = 36;
// A cluster tighter than this (degrees) won't split however far you zoom in.
const SAME_SPOT_DEG = 0.003;
const LIST_ZOOM = 14; // past this, clusters list their contents instead of zooming
const MAX_LISTED = 100;
const FULL_ALPHA = 100; // receivers with no free slots are faded
const ON_TOP = { cullMode: 'none', depthCompare: 'always', depthWriteEnabled: false };

const watts = (dbm) => {
  const w = 10 ** ((dbm - 30) / 10);
  return w >= 1 ? `${Math.round(w)} W` : `${Math.round(w * 1000)} mW`;
};
const siteFull = (s) => s.receivers.every((r) => r.max > 0 && r.users >= r.max);
const isStation = (p) => p.icon === 'station';

// Receiver clusters take the color of their most common type.
function commonIcon(members) {
  const counts = new Map();
  for (const m of members) counts.set(m.icon, (counts.get(m.icon) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

function contents(members) {
  const stations = members.filter(isStation).length;
  const receivers = members.length - stations;
  return [
    stations && `${stations.toLocaleString()} station${stations === 1 ? '' : 's'}`,
    receivers && `${receivers.toLocaleString()} receiver site${receivers === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' and ');
}

async function getJson(url) {
  const res = await fetch(url);
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
  return d;
}

// A surface-hugging great circle lifted into an arc, so paths read clearly over the map.
function arcPath(a, b, km) {
  const n = Math.max(6, Math.min(32, Math.round(km / 400)));
  const lift = km * 110; // meters at the middle of the path
  return geo.greatCircle(a, b, n).map(([lon, lat], i) => [lon, lat, Math.sin((Math.PI * i) / n) * lift]);
}

export function createRadio({ map, overlay, panelEl, extraEl, settings, save, onCount, onStatus, onSelect }) {
  const atlas = badgeAtlas(KINDS);
  let enabled = false;
  let sites = [];
  let sources = [];
  let stations = [];
  let paths = []; // spots with their arcs built
  let bandCounts = {};
  let ground = { source: null, key: '', data: [] };
  let raf = 0;
  let timers = [];
  const loading = {}; // kind -> promise, while it's loaded or loading
  const failed = {}; // kind -> message
  let sel = null; // { id, item, detail }
  let listing = false; // the panel is showing what's at a spot
  let dataStamp = 0; // changes with the markers, to redo the clusters
  let marks = { key: '', items: [] };
  let playing = null; // station details
  let streamError = null; // id of the station that wouldn't play

  const audio = new Audio();
  audio.preload = 'none';
  audio.volume = settings.volume;

  overlay.tooltip('radio', (x) => {
    if (x.band) {
      return `<b>${esc(x.tx)} → ${esc(x.rx)}</b><br>${x.km.toLocaleString()} km · ${esc(BAND_BY_MHZ.get(x.band).name)} · ${x.snr} dB · ${watts(x.dbm)}`;
    }
    if (x.members) return `<b>${contents(x.members)}</b><br>Click to see them`;
    if (x.receivers) return `<b>${esc(x.name)}</b><br>${esc([...new Set(x.receivers.map((r) => r.type))].join(', '))}`;
    return x.name ? `<b>${esc(x.name)}</b><br>Internet radio` : null;
  });

  // --- Data ------------------------------------------------------------------------

  const fail = (kind, label, err) => {
    console.error(err);
    failed[kind] = label;
    loading[kind] = null;
    report();
  };

  function loadSites() {
    loading.sites ??= getJson('/api/radio/receivers').then((d) => {
      sites = d.sites.map((s) => ({ ...s, icon: s.receivers[0].type, full: siteFull(s) }));
      sources = d.sources;
      dataStamp++;
      delete failed.sites;
      if (sel?.item?.receivers) sel.item = sites.find((s) => s.id === sel.id) || sel.item;
      report();
      requestDraw();
    }).catch((err) => fail('sites', 'Receivers unavailable', err));
    return loading.sites;
  }

  function loadStations() {
    loading.stations ??= getJson('/api/radio/stations').then((d) => {
      stations = d.stations.map(([id, name, lon, lat, clicks]) => ({ id, name, lon, lat, clicks, icon: 'station' }));
      dataStamp++;
      delete failed.stations;
      report();
      requestDraw();
    }).catch((err) => fail('stations', 'Stations unavailable', err));
    return loading.stations;
  }

  function loadPaths() {
    loading.paths = getJson('/api/radio/wspr').then((d) => {
      paths = d.paths.map(([tx, txLon, txLat, rx, rxLon, rxLat, band, km, snr, dbm]) => ({
        tx, rx, band, km, snr, dbm, arc: arcPath([txLon, txLat], [rxLon, rxLat], km),
      }));
      bandCounts = {};
      for (const p of paths) bandCounts[p.band] = (bandCounts[p.band] || 0) + 1;
      delete failed.paths;
      report();
      requestDraw();
    }).catch((err) => fail('paths', 'Shortwave paths unavailable', err));
    return loading.paths;
  }

  function loadWanted() {
    if (settings.sdr) loadSites();
    if (settings.stations) loadStations();
    if (settings.paths) loadPaths();
  }

  function report() {
    if (!enabled) return;
    const parts = [];
    if (settings.sdr && sites.length) parts.push(`${sites.length.toLocaleString()} receiver sites`);
    if (settings.stations && stations.length) parts.push(`${stations.length.toLocaleString()} stations`);
    if (settings.paths && paths.length) parts.push(`${paths.length.toLocaleString()} paths`);
    parts.push(...Object.values(failed));
    onCount((settings.sdr ? sites.length : 0) + (settings.stations ? stations.length : 0) + (settings.paths ? paths.length : 0));
    onStatus(`📻 ${parts.join(' · ') || 'Loading radio…'}`);
    renderExtra();
  }

  // --- Drawing ---------------------------------------------------------------------

  function requestDraw() {
    if (enabled && !raf) raf = requestAnimationFrame(draw);
  }

  // Paths on the ground skip depth testing, so the far side of the globe is cut off
  // here. The view is small at this zoom, so it's only redone after a sizeable move.
  function groundPaths() {
    const c = map.getCenter();
    const key = [map.getProjection?.()?.type, settings.hiddenBands, Math.round(c.lng / 5), Math.round(c.lat / 5)].join();
    if (ground.source === paths && ground.key === key) return ground.data;
    const hidden = geo.globeOccluder(map, Infinity);
    const data = [];
    for (const p of paths) {
      if (settings.hiddenBands.includes(p.band)) continue;
      let run = [];
      for (const [lon, lat] of p.arc) {
        if (!hidden?.([lon, lat])) {
          run.push([lon, lat]);
          continue;
        }
        if (run.length > 1) data.push({ ...p, arc: run });
        run = [];
      }
      if (run.length > 1) data.push({ ...p, arc: run });
    }
    ground = { source: paths, key, data };
    return data;
  }

  // Singles, then clusters so counts stay readable. Redone at every half zoom level.
  function clustered(zoom) {
    const level = Math.round(zoom * 2) / 2;
    const key = `${dataStamp}|${level}|${settings.sdr}|${settings.stations}`;
    if (key === marks.key) return marks.items;
    const group = (points) => {
      const { singles, clusters } = clusterPoints(points, level, CLUSTER_RADIUS_PX);
      for (const c of clusters) c.icon = commonIcon(c.members);
      return [...singles, ...clusters];
    };
    // Apart, because stations outnumber receivers 7 to 1 and would swallow them.
    marks = { key, items: [...(settings.stations ? group(stations) : []), ...(settings.sdr ? group(sites) : [])] };
    return marks.items;
  }

  function draw() {
    raf = 0;
    if (!enabled) return;
    const hidden = geo.globeOccluder(map, Infinity);
    const front = (list) => (hidden ? list.filter((s) => !hidden([s.lon, s.lat])) : list);
    const zoom = map.getZoom();
    const size = zoom < 4 ? 17 : zoom < 8 ? 17 + (zoom - 4) * 1.5 : 23;
    const pillSize = size + 2;
    const layers = [];
    if (settings.paths) {
      const off = settings.hiddenBands;
      // Zoomed in, the arcs would pass right by the camera, so they lie flat.
      const flat = zoom >= FLAT_ZOOM;
      layers.push(new deck.PathLayer({
        id: 'radio:paths',
        data: flat ? groundPaths() : paths.filter((p) => !off.includes(p.band)),
        getPath: (p) => p.arc,
        getColor: (p) => [...BAND_BY_MHZ.get(p.band).rgb, Math.max(70, Math.min(190, 170 + p.snr * 3))],
        getWidth: 1,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        wrapLongitude: true,
        pickable: true,
        ...(flat && { parameters: ON_TOP }),
        updateTriggers: { getColor: paths },
      }));
    }
    const visible = front(clustered(zoom));
    layers.push(new deck.IconLayer({
      id: 'radio:marks',
      data: visible,
      iconAtlas: atlas.canvas,
      iconMapping: atlas.mapping,
      getIcon: (m) => (m.members ? pillIcon(m.icon, m.members.length) : m.icon),
      getPosition: (m) => [m.lon, m.lat],
      getSize: (m) => (m.members ? pillSize : size),
      getColor: (m) => [255, 255, 255, m.full ? FULL_ALPHA : 255],
      sizeUnits: 'pixels',
      billboard: true,
      pickable: true,
      parameters: ON_TOP,
      updateTriggers: { getSize: size },
    }), countLayer('radio:counts', visible.filter((m) => m.members), pillSize, ON_TOP));
    const at = sel?.detail || sel?.item;
    if (at && front([at]).length) {
      // Drawn on its own, so it still shows when it's inside a cluster.
      layers.push(new deck.IconLayer({
        id: 'radio:selected-badge',
        data: [at],
        iconAtlas: atlas.canvas,
        iconMapping: atlas.mapping,
        getIcon: (x) => (x.receivers ? x.receivers[0].type : 'station'),
        getPosition: (x) => [x.lon, x.lat],
        getSize: size,
        sizeUnits: 'pixels',
        billboard: true,
        parameters: ON_TOP,
      }), new deck.ScatterplotLayer({
        id: 'radio:selected',
        data: [at],
        getPosition: (x) => [x.lon, x.lat],
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
    overlay.set('radio', layers);
  }

  // --- Playing ---------------------------------------------------------------------

  // An HTTPS page can't play plain HTTP streams, so those are links instead.
  const blocked = (s) => location.protocol === 'https:' && s.stream.startsWith('http:');

  function play(s) {
    if (blocked(s)) return;
    streamError = null;
    playing = s;
    audio.src = s.stream;
    audio.play().catch((err) => {
      // Stopped on purpose, or the browser wants a click first (links opened directly).
      if (playing !== s || err.name === 'AbortError') return;
      if (err.name === 'NotAllowedError') stop();
      else streamFailed();
    });
    renderNow();
    if (sel?.detail) renderPanel();
  }

  function stop() {
    playing = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    renderNow();
    if (sel?.detail) renderPanel();
  }

  function streamFailed() {
    if (!playing) return;
    streamError = playing.id;
    stop();
  }

  // --- Selection & panel -------------------------------------------------------------

  // Zooms into a cluster, or lists it when zooming wouldn't separate its contents.
  function openCluster(cluster) {
    const lons = cluster.members.map((m) => m.lon);
    const lats = cluster.members.map((m) => m.lat);
    const span = Math.max(Math.max(...lons) - Math.min(...lons), Math.max(...lats) - Math.min(...lats));
    if (span < SAME_SPOT_DEG || map.getZoom() >= LIST_ZOOM) showList(cluster.members);
    else zoomToCluster(map, cluster);
  }

  function showList(members) {
    const $ = (q) => panelEl.querySelector(q);
    const list = [...members].sort((a, b) => (b.clicks || 0) - (a.clicks || 0));
    sel = null;
    listing = true;
    onSelect?.();
    panelEl.hidden = false;
    $('[data-name]').textContent = contents(members);
    $('[data-kind]').textContent = 'At this spot';
    $('[data-body]').innerHTML = `<ul class="radio-list">${list.slice(0, MAX_LISTED).map((m) => `
      <li><button data-open="${esc(m.id)}">${badgeSvg(kindOf(m.icon))}<span>${esc(m.name)}</span></button></li>`).join('')}</ul>
      ${list.length > MAX_LISTED ? `<p class="fp-warn">Showing the ${MAX_LISTED} most played.</p>` : ''}`;
    $('[data-source]').textContent = '';
    requestDraw();
  }

  async function select(id, { autoplay = false } = {}) {
    listing = false;
    if (!id) {
      sel = null;
      panelEl.hidden = true;
      requestDraw();
      return;
    }
    if (id.startsWith('fm:')) {
      sel = { id, item: stations.find((s) => s.id === id) || null, detail: null };
      onSelect?.();
      renderPanel();
      requestDraw();
      try {
        const detail = await getJson(`/api/radio/stations/${encodeURIComponent(id)}`);
        if (sel?.id !== id) return;
        sel.detail = detail;
        renderPanel();
        requestDraw();
        if (autoplay && playing?.id !== id) play(detail);
      } catch (err) {
        console.error(err);
        if (sel?.id === id) {
          sel = null;
          panelEl.hidden = true;
          onStatus('📻 That station is no longer listed');
        }
      }
      return;
    }
    const item = sites.find((s) => s.id === id);
    if (!item) return;
    sel = { id, item };
    onSelect?.();
    renderPanel();
    requestDraw();
  }

  function renderPanel() {
    const $ = (q) => panelEl.querySelector(q);
    const stat = (label, value) => (value == null || value === '' ? '' : `<div><dt>${label}</dt><dd>${esc(String(value))}</dd></div>`);
    panelEl.hidden = false;
    if (sel.id.startsWith('fm:')) {
      const s = sel.detail;
      $('[data-name]').textContent = s?.name || sel.item?.name || 'Loading…';
      $('[data-kind]').textContent = ['Internet radio', s?.country].filter(Boolean).join(' · ');
      if (!s) {
        $('[data-body]').innerHTML = '';
        $('[data-source]').textContent = '';
        return;
      }
      const on = playing?.id === s.id;
      const cantPlay = blocked(s);
      $('[data-body]').innerHTML = `
        <dl class="fp-stats">
          ${stat('Language', s.language)}
          ${stat('Format', [s.codec, s.bitrate && `${s.bitrate} kbit/s`].filter(Boolean).join(' · '))}
          ${s.tags ? `<div class="wide"><dt>Tags</dt><dd>${esc(s.tags)}</dd></div>` : ''}
        </dl>
        <div class="fp-actions">
          ${cantPlay ? `<a class="fp-btn" href="${esc(s.stream)}" target="_blank" rel="noopener">Open stream</a>`
            : `<button class="fp-btn" data-play aria-pressed="${on}">${on ? 'Stop' : 'Play'}</button>`}
          ${s.home ? `<a class="fp-btn" href="${esc(s.home)}" target="_blank" rel="noopener">Website</a>` : ''}
        </div>
        ${streamError === s.id ? '<p class="fp-warn">This stream isn\'t answering. Try its website.</p>' : ''}
        ${cantPlay ? '<p class="fp-warn">This stream is not encrypted, so browsers won\'t play it inside this page.</p>' : ''}`;
      $('[data-source]').innerHTML = 'Source: <a href="https://www.radio-browser.info/" target="_blank" rel="noopener">Radio Browser</a>';
      return;
    }
    const site = sel.item;
    $('[data-name]').textContent = site.name;
    $('[data-kind]').textContent = `${site.receivers.length === 1 ? 'SDR receiver' : `${site.receivers.length} SDR receivers`} · ${site.lat.toFixed(2)}°, ${site.lon.toFixed(2)}°`;
    $('[data-body]').innerHTML = site.receivers.map((r) => {
      const full = r.max > 0 && r.users >= r.max;
      const facts = [
        r.type,
        r.max ? `${r.users} of ${r.max} listening` : null,
        r.bands,
        Number.isFinite(r.snr) && r.snr > 0 ? `signal ${r.snr} dB` : null,
      ].filter(Boolean).join(' · ');
      return `<section class="radio-rx">
        ${r.name !== site.name ? `<b>${esc(r.name)}</b>` : ''}
        <p>${esc(facts)}</p>
        ${r.antenna ? `<p>Antenna: ${esc(r.antenna)}</p>` : ''}
        <a class="fp-btn" href="${esc(r.url)}" target="_blank" rel="noopener">${full ? 'Open receiver (full)' : 'Open receiver'}</a>
      </section>`;
    }).join('');
    $('[data-source]').innerHTML = 'Each receiver is run by a volunteer and opens on their own site. Source: <a href="https://www.receiverbook.de/" target="_blank" rel="noopener">Receiverbook</a>, <a href="http://rx.linkfanel.net/" target="_blank" rel="noopener">KiwiSDR list</a>';
  }

  // --- Layer controls ----------------------------------------------------------------

  function renderExtra() {
    if (!extraEl.firstElementChild) {
      extraEl.innerHTML = `
        <label class="sub-row">
          <input type="checkbox" data-sub="sdr">
          <span class="layer-name">SDR receivers</span><span class="radio-count" data-count="sdr"></span>
        </label>
        <div class="rad-legend radio-types">${RECEIVER_TYPES.map((k) => `<span>${badgeSvg(k)}${k.id}</span>`).join('')}</div>
        <p class="ev-hint">Real radios you can tune from your browser. Faded dots are full right now.</p>
        <label class="sub-row">
          <input type="checkbox" data-sub="stations">
          ${badgeSvg(kindOf('station'))}
          <span class="layer-name">Internet radio</span><span class="radio-count" data-count="stations"></span>
        </label>
        <div class="radio-now" data-now hidden>
          <span data-now-name></span>
          <input type="range" min="0" max="1" step="0.05" data-volume aria-label="Volume">
          <button class="fp-btn" data-stop>Stop</button>
        </div>
        <label class="sub-row">
          <input type="checkbox" data-sub="paths">
          <span class="layer-name">Shortwave paths</span><span class="radio-count" data-count="paths"></span>
        </label>
        <div class="radio-bands" data-bands>${BANDS.map((b) => `
          <label><input type="checkbox" data-band="${b.mhz}"><i style="background:${b.color}"></i>${b.name}</label>`).join('')}
        </div>
        <p class="ev-hint">Low-power WSPR beacons heard in the last 15 minutes, showing where shortwave is open. A sample of about 5,000 paths.</p>
        <p class="ev-hint" data-sources></p>`;
      extraEl.addEventListener('change', (e) => {
        const { sub, band } = e.target.dataset;
        if (sub) {
          settings[sub] = e.target.checked;
          dataStamp++;
          save();
          loadWanted();
          report();
          requestDraw();
        } else if (band) {
          const mhz = Number(band);
          settings.hiddenBands = e.target.checked ? settings.hiddenBands.filter((b) => b !== mhz) : [...settings.hiddenBands, mhz];
          save();
          requestDraw();
        }
      });
      extraEl.querySelector('[data-volume]').addEventListener('input', (e) => {
        settings.volume = audio.volume = Number(e.target.value);
        save();
      });
      extraEl.querySelector('[data-stop]').addEventListener('click', stop);
    }
    const one = (q) => extraEl.querySelector(q);
    for (const box of extraEl.querySelectorAll('[data-sub]')) box.checked = settings[box.dataset.sub];
    one('[data-count="sdr"]').textContent = sites.length ? sites.length.toLocaleString() : '';
    one('[data-count="stations"]').textContent = stations.length ? stations.length.toLocaleString() : '';
    one('[data-count="paths"]').textContent = paths.length ? paths.length.toLocaleString() : '';
    one('[data-bands]').hidden = !settings.paths;
    for (const box of extraEl.querySelectorAll('[data-band]')) {
      box.checked = !settings.hiddenBands.includes(Number(box.dataset.band));
      box.parentElement.title = `${(bandCounts[box.dataset.band] || 0).toLocaleString()} paths`;
    }
    one('[data-sources]').innerHTML = sources.filter((s) => !s.ok).map((s) => `${esc(s.name)} unavailable`).join(' · ');
    renderNow();
  }

  function renderNow() {
    const now = extraEl.querySelector('[data-now]');
    if (!now) return;
    now.hidden = !playing;
    now.querySelector('[data-now-name]').textContent = playing ? `▶ ${playing.name}` : '';
    now.querySelector('[data-volume]').value = audio.volume;
  }

  // --- Wiring ------------------------------------------------------------------------

  audio.addEventListener('error', () => {
    if (audio.getAttribute('src')) streamFailed();
  });
  panelEl.querySelector('[data-close]').addEventListener('click', () => select(null));
  panelEl.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]')?.dataset.open;
    if (open) {
      select(open, { autoplay: open.startsWith('fm:') });
      return;
    }
    if (!e.target.closest('[data-play]') || !sel?.detail) return;
    if (playing?.id === sel.detail.id) stop();
    else play(sel.detail);
  });
  map.on('move', () => {
    if (enabled && geo.globeOccluder(map, Infinity)) requestDraw();
  });
  map.on('zoom', requestDraw);
  map.on('click', (e) => {
    if (!enabled) return;
    const info = overlay.pick(e.point, PICK_LAYERS);
    if (info?.object?.members) openCluster(info.object);
    else if (info?.object?.id) select(info.object.id, { autoplay: info.object.id.startsWith('fm:') });
    else if ((sel || listing) && !overlay.pick(e.point)) select(null);
  });

  return {
    select,
    async focus(id, { fly = true } = {}) {
      const kind = id.startsWith('fm:') ? 'stations' : 'sdr';
      if (!settings[kind]) {
        settings[kind] = true;
        save();
        renderExtra();
      }
      await (kind === 'sdr' ? loadSites() : loadStations());
      // `fly` is off for links, which open without a click and so can't start sound.
      await select(id, { autoplay: fly && kind === 'stations' });
    },
    selected: () => sel?.id ?? null,
    deselect: () => { if (sel || listing) select(null); },
    setTheme() { /* fixed, meaningful colors in every theme */ },
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      extraEl.hidden = !on;
      for (const t of timers) clearInterval(t);
      timers = [];
      if (!on) {
        cancelAnimationFrame(raf);
        raf = 0;
        stop();
        select(null);
        overlay.set('radio', []);
        onCount(null);
        onStatus('');
        return;
      }
      renderExtra();
      report();
      loadWanted();
      timers = [
        setInterval(() => { if (settings.paths) loadPaths(); }, PATHS_EVERY_MS),
        setInterval(() => {
          loading.sites = null;
          if (settings.sdr) loadSites();
        }, SITES_EVERY_MS),
      ];
      requestDraw();
    },
  };
}
