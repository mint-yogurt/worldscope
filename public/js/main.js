import { THEMES, DEFAULT_THEME } from './themes.js';
import { createWorldMap, yesterdayUTC, GIBS_FIRST_DATE } from './map.js';
import { createEffects } from './effects.js';
import { createOverlay } from './overlay.js';
import { createFlights } from './layers/flights.js';
import { createWeather } from './layers/weather.js';
import { createSatellites } from './layers/satellites.js';
import { createSpaceWeather } from './layers/space-weather.js';
import { createEvents } from './layers/events.js';
import { createShips } from './layers/ships.js';
import { createRadiation } from './layers/radiation.js';
import { createRadio } from './layers/radio.js';
import { createWebcams } from './layers/webcams.js';
import { createOutages } from './layers/outages.js';
import { createLaunches } from './layers/launches.js';
import { createEmergencies } from './layers/emergencies.js';
import { createCountries } from './layers/countries.js';
import { createSearch } from './search.js';
import { parseLink, buildLink } from './share.js';
import { createTour } from './tour.js';

// Data layers from the plan (docs/data-sources.md). Each flips to "ready"
// once it's built; for now they're placeholders so the panel shows the shape.
const DATA_LAYERS = [
  { id: 'emergencies', name: 'Emergencies', status: 'ready' },
  { id: 'countries', name: 'Countries & flags', status: 'ready' },
  { id: 'weather', name: 'Weather', status: 'ready' },
  { id: 'space', name: 'Night, Sun & aurora', status: 'ready' },
  { id: 'radiation', name: 'Radiation', status: 'ready' },
  { id: 'flights', name: 'Flights', status: 'ready' },
  { id: 'ships', name: 'Ships', status: 'ready' },
  { id: 'satellites', name: 'Satellites', status: 'ready' },
  { id: 'events', name: 'World events', status: 'ready' },
  { id: 'webcams', name: 'Webcams', status: 'ready' },
  { id: 'radio', name: 'Radio', status: 'ready' },
  { id: 'outages', name: 'Internet outages', status: 'ready' },
  { id: 'launches', name: 'Rocket launches', status: 'ready' },
];

// Per-viewer preferences. Storage can be unavailable (private mode etc.), so never rely on it.
const PREFS_KEY = 'worldscope.prefs';
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}
function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const saved = loadPrefs();
const prefs = {
  theme: THEMES[saved.theme] ? saved.theme : DEFAULT_THEME,
  mode: ['streets', 'satellite', 'space'].includes(saved.mode) ? saved.mode : 'streets',
  globe: saved.globe ?? true,
  fx: saved.fx ?? !reducedMotion,
  layers: { flights: true, emergencies: true, ...saved.layers },
  weather: { variable: 'temperature_2m', particles: true, ...saved.weather },
  satellites: { categories: ['station', 'constellation', 'gnss', 'weather', 'geo', 'other'], ...saved.satellites },
  // Event filters store what's hidden, so kinds added later are on by default.
  events: { hours: 168, hidden: [], minor: false, ...saved.events, kinds: undefined },
  ships: { hidden: [], stopped: true, ...saved.ships },
  radiation: { survey: false, ...saved.radiation },
  radio: { sdr: true, stations: true, paths: true, hiddenBands: [], volume: 0.7, ...saved.radio },
  webcams: { hidden: [], ...saved.webcams },
  outages: { hidden: [], ...saved.outages },
  launches: { hidden: [], ...saved.launches },
  countries: { flags: true, opacity: 0.6, hidden: [], ...saved.countries },
};

// A shared link overrides saved preferences for this visit.
const DEFAULTS = { theme: DEFAULT_THEME, mode: 'streets' };
const link = parseLink(location.hash);
if (THEMES[link.theme]) prefs.theme = link.theme;
if (['streets', 'satellite', 'space'].includes(link.mode)) prefs.mode = link.mode;
if (link.globe !== undefined) prefs.globe = link.globe;
if (link.layers) prefs.layers = Object.fromEntries(link.layers.map((id) => [id, true]));

// What a search result or link can point at, and the layer that owns it.
const SELECTABLE = {
  country: 'countries', ship: 'ships', flight: 'flights', satellite: 'satellites', event: 'events', radiation: 'radiation',
  webcam: 'webcams', radio: 'radio', outage: 'outages', launch: 'launches',
};

// Built data layers, keyed like DATA_LAYERS. Each has setEnabled(bool) and setTheme(id).
const features = {};

const $ = (id) => document.getElementById(id);
const effects = createEffects($('fx'));
const status = (msg) => { $('status-msg').textContent = msg; };

// --- Theme ------------------------------------------------------------------

function buildThemePicker(onPick) {
  const picker = $('theme-picker');
  for (const [id, theme] of Object.entries(THEMES)) {
    const btn = document.createElement('button');
    btn.className = 'swatch';
    btn.setAttribute('role', 'radio');
    btn.dataset.theme = id;
    btn.title = theme.name;
    btn.setAttribute('aria-label', theme.name);
    btn.style.setProperty('--a', theme.swatch[0]);
    btn.style.setProperty('--b', theme.swatch[1]);
    btn.addEventListener('click', () => onPick(id));
    picker.insertBefore(btn, $('fx-toggle'));
  }
}

function applyThemeToPage(id) {
  document.documentElement.dataset.theme = id;
  for (const btn of document.querySelectorAll('.swatch')) {
    btn.setAttribute('aria-checked', String(btn.dataset.theme === id));
  }
  const fxBtn = $('fx-toggle');
  fxBtn.hidden = !THEMES[id].effect;
  fxBtn.setAttribute('aria-pressed', String(prefs.fx));
  effects.set(prefs.fx ? THEMES[id].effect : null);
}

// --- Panels -----------------------------------------------------------------

function buildLayerList() {
  const list = $('layer-list');
  for (const layer of DATA_LAYERS) {
    const ready = layer.status === 'ready';
    const li = document.createElement('li');
    li.innerHTML = `
      <label class="layer-row" data-status="${layer.status}">
        <input type="checkbox" data-layer="${layer.id}" ${ready ? '' : 'disabled'}>
        <span class="layer-name">${layer.name}</span>
        <span class="tag" id="tag-${layer.id}" ${ready ? 'hidden' : ''}>${layer.status}</span>
      </label>
      <div class="layer-extra" id="extra-${layer.id}" hidden></div>`;
    list.append(li);
  }
  list.addEventListener('change', (e) => {
    const id = e.target.dataset.layer; // sub-controls inside .layer-extra have no data-layer
    if (!id) return;
    prefs.layers[id] = e.target.checked;
    savePrefs(prefs);
    features[id]?.setEnabled(e.target.checked);
  });
  $('layers-toggle').addEventListener('click', (e) => {
    const open = document.body.classList.toggle('layers-open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });
}

// Each data layer gets its own slot in the status bar.
function setLayerStatus(id, msg) {
  let span = $(`status-${id}`);
  if (!span) {
    span = document.createElement('span');
    span.id = `status-${id}`;
    $('status-layers').append(span);
  }
  span.textContent = msg;
  span.hidden = !msg;
}

function setLayerCount(id, n) {
  const tag = $(`tag-${id}`);
  tag.hidden = n == null;
  tag.textContent = n == null ? '' : n.toLocaleString();
}

function setModeButtons(mode) {
  for (const btn of document.querySelectorAll('#basemap-modes button')) {
    btn.setAttribute('aria-checked', String(btn.dataset.mode === mode));
  }
  $('daily-date-wrap').hidden = mode !== 'space';
}

function startClock() {
  const tick = () => {
    const now = new Date();
    $('clock-utc').textContent = now.toISOString().slice(11, 19);
    $('clock-date').textContent = now.toISOString().slice(0, 10);
  };
  tick();
  setInterval(tick, 1000);
}

function formatCoord(value, pos, neg) {
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? pos : neg}`;
}

// Keeps the server's ship feeds awake. Hidden tabs don't count as viewing.
function reportPresence() {
  let last = 0;
  const ping = () => {
    // Switching tabs can fire this many times a minute.
    if (document.hidden || Date.now() - last < 30_000) return;
    last = Date.now();
    fetch('/api/presence').catch(() => {});
  };
  ping();
  setInterval(ping, 60_000);
  document.addEventListener('visibilitychange', ping);
}

// --- Boot -------------------------------------------------------------------

async function main() {
  reportPresence();
  buildThemePicker(pickTheme);
  buildLayerList();
  applyThemeToPage(prefs.theme);
  setModeButtons(prefs.mode);
  startClock();

  const dateInput = $('daily-date');
  dateInput.min = GIBS_FIRST_DATE;
  dateInput.max = yesterdayUTC();
  dateInput.value = yesterdayUTC();
  $('globe-toggle').checked = prefs.globe;

  status('Loading map…');
  let world;
  try {
    world = await createWorldMap($('map'), { ...prefs, view: link, gibsDate: dateInput.value });
  } catch (err) {
    console.error(err);
    status(`Map failed to load: ${err.message}`);
    return;
  }
  const { map } = world;
  // Canvases go inside the map container, so map popups can sit above them.
  map.getContainer().append($('wind'), $('fx'));
  map.on('load', () => status(''));
  map.on('error', (e) => console.warn('Map error:', e.error?.message || e));

  map.on('mousemove', (e) => {
    $('status-coords').textContent =
      `${formatCoord(e.lngLat.lat, 'N', 'S')}  ${formatCoord(e.lngLat.lng, 'E', 'W')}`;
  });
  const showZoom = () => { $('status-zoom').textContent = `z ${map.getZoom().toFixed(1)}`; };
  map.on('zoom', showZoom);
  showZoom();

  const overlay = createOverlay(map);
  window.worldscope = { ...world, overlay, features }; // handy for poking at the map from devtools
  // Only one thing is selected at a time: selecting in one layer clears the others.
  const selectedIn = (id) => () => {
    for (const [other, f] of Object.entries(features)) if (other !== id) f.deselect?.();
  };

  // --- Opening things ---------------------------------------------------------------

  async function setLayer(id, on) {
    const box = document.querySelector(`[data-layer="${id}"]`);
    if (box.checked === on) return;
    box.checked = on;
    prefs.layers[id] = on;
    savePrefs(prefs);
    await features[id].setEnabled(on);
  }

  // Fly to a search result or linked object and open its panel.
  let pin = null;
  async function open(item) {
    pin?.remove();
    pin = null;
    if (Number.isFinite(item.lon) && Number.isFinite(item.lat) && item.fly !== false) {
      map.flyTo({ center: [item.lon, item.lat], zoom: Math.max(map.getZoom(), item.zoom || 8), duration: 1800, essential: true });
    }
    const owner = SELECTABLE[item.type];
    if (!owner) {
      for (const feature of Object.values(features)) feature.deselect?.();
      const el = document.createElement('div');
      el.className = 'search-pin';
      pin = new maplibregl.Marker({ element: el }).setLngLat([item.lon, item.lat]).addTo(map);
      writeLink();
      return;
    }
    if (owner !== 'countries') await setLayer(owner, true);
    await features[owner].focus(item.id, { fly: item.fly !== false });
    writeLink();
  }

  function currentSelection() {
    for (const [type, owner] of Object.entries(SELECTABLE)) {
      const id = features[owner]?.selected?.();
      if (id != null) return { type, id };
    }
    return null;
  }

  // The address bar follows the view, without adding to the back button's history.
  let linkTimer = 0;
  function writeLink() {
    clearTimeout(linkTimer);
    linkTimer = setTimeout(() => {
      history.replaceState(null, '', buildLink({
        map,
        layers: DATA_LAYERS.filter((l) => prefs.layers[l.id]).map((l) => l.id),
        selection: currentSelection(),
        theme: prefs.theme,
        mode: prefs.mode,
        globe: prefs.globe,
        tour: tour.running(),
        defaults: DEFAULTS,
      }));
    }, 300);
  }

  // The tour turns on what its stops need, then puts the layers back as they were.
  let layersBefore = null;
  const tour = createTour({
    map,
    open,
    reducedMotion,
    els: {
      card: $('tour-card'), kicker: $('tour-kicker'), title: $('tour-title'), sub: $('tour-sub'), step: $('tour-step'),
      bar: $('tour-bar'), pause: $('tour-pause'), next: $('tour-next'), prev: $('tour-prev'), stop: $('tour-stop'),
    },
    onStart() {
      layersBefore = { ...prefs.layers };
      writeLink();
    },
    onStop() {
      for (const layer of DATA_LAYERS) setLayer(layer.id, !!layersBefore[layer.id]);
      for (const feature of Object.values(features)) feature.deselect?.();
      writeLink();
    },
  });
  $('tour-start').addEventListener('click', tour.start);

  createSearch({ form: $('search'), input: $('search-input'), list: $('search-results'), onPick: open });

  $('share').addEventListener('click', async () => {
    const btn = $('share');
    try {
      await navigator.clipboard.writeText(location.href);
      btn.title = 'Link copied';
    } catch {
      btn.title = 'Copy the address bar instead: your browser blocked this';
    }
    btn.classList.add('done');
    setTimeout(() => { btn.classList.remove('done'); btn.title = 'Copy a link to this view'; }, 1800);
  });

  features.countries = createCountries({
    map,
    overlay,
    panelEl: $('country-panel'),
    extraEl: $('extra-countries'),
    settings: prefs.countries,
    save: () => savePrefs(prefs),
    onSelect: selectedIn('countries'),
    onOpen: open,
    onStatus: (msg) => setLayerStatus('countries', msg),
  });
  features.flights = createFlights({
    map,
    overlay,
    panelEl: $('flight-panel'),
    onCount: (n) => setLayerCount('flights', n),
    onStatus: (msg) => setLayerStatus('flights', msg),
    onSelect: selectedIn('flights'),
  });
  features.satellites = createSatellites({
    map,
    overlay,
    panelEl: $('sat-panel'),
    extraEl: $('extra-satellites'),
    settings: prefs.satellites,
    save: () => savePrefs(prefs),
    onCount: (n) => setLayerCount('satellites', n),
    onStatus: (msg) => setLayerStatus('satellites', msg),
    onSelect: selectedIn('satellites'),
  });
  features.events = createEvents({
    map,
    overlay,
    panelEl: $('event-panel'),
    extraEl: $('extra-events'),
    settings: prefs.events,
    save: () => savePrefs(prefs),
    onCount: (n) => setLayerCount('events', n),
    onStatus: (msg) => setLayerStatus('events', msg),
    onSelect: selectedIn('events'),
  });
  features.ships = createShips({
    map,
    overlay,
    panelEl: $('ship-panel'),
    extraEl: $('extra-ships'),
    settings: prefs.ships,
    save: () => savePrefs(prefs),
    onCount: (n) => setLayerCount('ships', n),
    onStatus: (msg) => setLayerStatus('ships', msg),
    onSelect: selectedIn('ships'),
  });
  features.radiation = createRadiation({
    map,
    overlay,
    panelEl: $('rad-panel'),
    extraEl: $('extra-radiation'),
    settings: prefs.radiation,
    save: () => savePrefs(prefs),
    onCount: (n) => setLayerCount('radiation', n),
    onStatus: (msg) => setLayerStatus('radiation', msg),
    onSelect: selectedIn('radiation'),
  });
  features.radio = createRadio({
    map,
    overlay,
    panelEl: $('radio-panel'),
    extraEl: $('extra-radio'),
    settings: prefs.radio,
    save: () => savePrefs(prefs),
    onCount: (n) => setLayerCount('radio', n),
    onStatus: (msg) => setLayerStatus('radio', msg),
    onSelect: selectedIn('radio'),
  });
  features.webcams = createWebcams({
    map,
    overlay,
    panelEl: $('cam-panel'),
    extraEl: $('extra-webcams'),
    settings: prefs.webcams,
    save: () => savePrefs(prefs),
    onCount: (n) => setLayerCount('webcams', n),
    onStatus: (msg) => setLayerStatus('webcams', msg),
    onSelect: selectedIn('webcams'),
  });
  features.outages = createOutages({
    map,
    overlay,
    panelEl: $('outage-panel'),
    extraEl: $('extra-outages'),
    settings: prefs.outages,
    save: () => savePrefs(prefs),
    onCount: (n) => setLayerCount('outages', n),
    onStatus: (msg) => setLayerStatus('outages', msg),
    onSelect: selectedIn('outages'),
  });
  features.launches = createLaunches({
    map,
    overlay,
    panelEl: $('launch-panel'),
    extraEl: $('extra-launches'),
    settings: prefs.launches,
    save: () => savePrefs(prefs),
    onCount: (n) => setLayerCount('launches', n),
    onStatus: (msg) => setLayerStatus('launches', msg),
    onSelect: selectedIn('launches'),
  });
  features.emergencies = createEmergencies({
    el: $('alerts'),
    extraEl: $('extra-emergencies'),
    onOpen: open,
    onCount: (n) => setLayerCount('emergencies', n),
    onStatus: (msg) => setLayerStatus('emergencies', msg),
  });
  features.space = createSpaceWeather({
    map,
    overlay,
    extraEl: $('extra-space'),
    onStatus: (msg) => setLayerStatus('space', msg),
  });
  features.weather = createWeather({
    map,
    overlay,
    els: {
      bar: $('weather-bar'),
      overlays: $('wx-overlays'),
      play: $('wx-play'),
      time: $('wx-time'),
      timeLabel: $('wx-time-label'),
      legendBar: $('wx-legend-bar'),
      legendTicks: $('wx-legend-ticks'),
      legendUnit: $('wx-unit'),
      particlesToggle: $('wx-particles'),
      windCanvas: $('wind'),
    },
    settings: prefs.weather,
    save: () => savePrefs(prefs),
    onStatus: (msg) => setLayerStatus('weather', msg),
    onValue: (msg) => { $('status-value').textContent = msg; },
  });
  for (const [id, feature] of Object.entries(features)) {
    feature.setTheme(prefs.theme);
    document.querySelector(`[data-layer="${id}"]`).checked = !!prefs.layers[id];
    // Read the pref again at load time: it may have been toggled while the map was loading.
    map.once('load', () => feature.setEnabled(!!prefs.layers[id]));
  }

  // Selections change through clicks: on the map, a panel's close button, or a list.
  map.on('moveend', writeLink);
  map.on('click', writeLink);
  document.addEventListener('click', writeLink);
  document.addEventListener('change', writeLink);

  // Open what the link points at once the layers are up.
  map.once('load', async () => {
    if (link.tour) tour.start();
    else if (link.selection && SELECTABLE[link.selection.type]) open({ ...link.selection, fly: false });
    else writeLink();
  });
  // A link pasted into a tab that's already open.
  window.addEventListener('hashchange', () => {
    const next = parseLink(location.hash);
    if (next.center) map.jumpTo({ center: next.center, zoom: next.zoom, bearing: next.bearing, pitch: next.pitch });
    for (const layer of DATA_LAYERS) {
      if (!next.layers || layer.status !== 'ready') continue;
      const on = next.layers.includes(layer.id);
      const box = document.querySelector(`[data-layer="${layer.id}"]`);
      if (box.checked !== on) box.click();
    }
    if (next.selection && SELECTABLE[next.selection.type]) open({ ...next.selection, fly: false });
  });

  function pickTheme(id) {
    prefs.theme = id;
    savePrefs(prefs);
    applyThemeToPage(id);
    world?.setTheme(id);
    for (const feature of Object.values(features)) feature.setTheme(id);
  }

  $('fx-toggle').addEventListener('click', () => {
    prefs.fx = !prefs.fx;
    savePrefs(prefs);
    applyThemeToPage(prefs.theme);
  });

  for (const btn of document.querySelectorAll('#basemap-modes button')) {
    btn.addEventListener('click', () => {
      prefs.mode = btn.dataset.mode;
      savePrefs(prefs);
      setModeButtons(prefs.mode);
      world.setMode(prefs.mode);
    });
  }

  dateInput.addEventListener('change', () => {
    if (dateInput.value) world.setGibsDate(dateInput.value);
  });

  $('globe-toggle').addEventListener('change', (e) => {
    prefs.globe = e.target.checked;
    savePrefs(prefs);
    world.setGlobe(prefs.globe);
  });
}

main();
