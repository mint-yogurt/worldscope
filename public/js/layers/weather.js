// Weather layer, Windy-style:
//   - colored overlays (temperature, rain, clouds, wind, ...) from Open-Meteo's
//     ECMWF IFS files, rendered in the browser by @openmeteo/weather-map-layer
//     through a custom om:// MapLibre protocol (data straight from their S3 bucket)
//   - a timeline across the model run (hourly, ~15 days) with play/pause
//   - animated wind particles (GFS, via our server)
//   - the overlay's value under the cursor, and a forecast popup on click

import { OVERLAY_BEFORE_ID } from '../map.js';
import { createWindParticles } from './wind-particles.js';
import { forecastHtml } from './forecast-popup.js';

const OM_LIB = 'https://unpkg.com/@openmeteo/weather-map-layer@0.3.0/dist/index.mjs';
const MODEL = 'https://openmeteo.s3.amazonaws.com/data_spatial/ecmwf_ifs';
const SOURCE_ID = 'wx';
const LAYER_ID = 'wx-raster';
const PLAY_EVERY_MS = 1500;

export const OVERLAYS = [
  { id: 'temperature_2m', label: 'Temp', name: 'Temperature' },
  { id: 'precipitation', label: 'Rain', name: 'Precipitation' },
  { id: 'cloud_cover', label: 'Clouds', name: 'Cloud cover' },
  { id: 'wind_speed_10m', label: 'Wind', name: 'Wind speed' },
  { id: 'wind_gusts_10m', label: 'Gusts', name: 'Wind gusts' },
  { id: 'pressure_msl', label: 'Pressure', name: 'Sea-level pressure' },
  { id: 'cape', label: 'Storms', name: 'Thunderstorm energy (CAPE)' },
  { id: 'relative_humidity_2m', label: 'Humidity', name: 'Relative humidity' },
  { id: 'visibility', label: 'Fog', name: 'Visibility' },
  { id: 'snow_depth', label: 'Snow', name: 'Snow depth' },
  { id: 'sea_surface_temperature', label: 'Sea temp', name: 'Sea surface temperature' },
];

const debounce = (fn, ms) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

function formatValue(v, unit) {
  if (!Number.isFinite(v)) return '—';
  const digits = Math.abs(v) >= 100 ? 0 : 1;
  if (unit === 'm/s') return `${v.toFixed(1)} m/s (${Math.round(v * 3.6)} km/h)`;
  return `${v.toFixed(digits)} ${unit}`;
}

export function createWeather({ map, overlay, els, settings, save, onStatus, onValue }) {
  let OM = null;
  let enabled = false;
  let validTimes = [];
  let referenceTime = null;
  let timeIndex = 0;
  let playTimer = 0;
  let metaTimer = 0;
  let popup = null;
  let scale = null;
  const windCache = new Map();
  const particles = createWindParticles(map, els.windCanvas);

  // --- Setup ------------------------------------------------------------------

  async function loadLibrary() {
    if (OM) return;
    OM = await import(OM_LIB);
    maplibregl.addProtocol('om', OM.omProtocol);
  }

  async function loadMeta() {
    const meta = await fetch(`${MODEL}/latest.json`).then((r) => r.json());
    const keepTime = validTimes[timeIndex];
    validTimes = meta.valid_times;
    referenceTime = meta.reference_time;
    // Stay on the same moment if possible, otherwise jump to the current hour.
    const now = Date.now();
    const target = keepTime || new Date(now - (now % 3600_000)).toISOString().slice(0, 16) + 'Z';
    const i = validTimes.findIndex((t) => Date.parse(t) >= Date.parse(target));
    timeIndex = i >= 0 ? i : 0;
    els.time.max = validTimes.length - 1;
    els.time.value = timeIndex;
    updateTimeLabel();
  }

  function omUrl() {
    return `${MODEL}/latest.json?time_step=valid_times_${timeIndex}&variable=${settings.variable}&dark=true`;
  }

  function applySource() {
    const url = `om://${omUrl()}`;
    const src = map.getSource(SOURCE_ID);
    if (src) {
      src.setUrl(url);
    } else {
      map.addSource(SOURCE_ID, { type: 'raster', url });
      map.addLayer({
        id: LAYER_ID,
        type: 'raster',
        source: SOURCE_ID,
        paint: { 'raster-opacity': 0.72, 'raster-resampling': 'linear' },
      }, map.getLayer(OVERLAY_BEFORE_ID) ? OVERLAY_BEFORE_ID : undefined);
    }
  }

  function removeSource() {
    if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  }

  // --- UI -----------------------------------------------------------------------

  function buildOverlayButtons() {
    els.overlays.innerHTML = '';
    for (const o of OVERLAYS) {
      const btn = document.createElement('button');
      btn.setAttribute('role', 'radio');
      btn.dataset.variable = o.id;
      btn.textContent = o.label;
      btn.title = o.name;
      btn.addEventListener('click', () => setVariable(o.id));
      els.overlays.append(btn);
    }
  }

  function updateLegend() {
    scale = OM.getColorScale(settings.variable, true);
    const n = scale.colors.length;
    const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
    els.legendBar.style.background =
      `linear-gradient(90deg, ${scale.colors.map((c, i) => `${rgb(c)} ${((i / (n - 1)) * 100).toFixed(1)}%`).join(', ')})`;
    const bps = scale.breakpoints || [];
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (bps.length - 1)));
    els.legendTicks.innerHTML = bps.length
      ? [...new Set(ticks)].map((i) => `<span style="left:${(i / (bps.length - 1)) * 100}%">${+bps[i].toFixed(2)}</span>`).join('')
      : `<span style="left:0">${scale.min}</span><span style="left:100%">${scale.max}</span>`;
    els.legendUnit.textContent = scale.unit || '';
    for (const btn of els.overlays.children) {
      btn.setAttribute('aria-checked', String(btn.dataset.variable === settings.variable));
    }
  }

  function updateTimeLabel() {
    const t = validTimes[timeIndex];
    if (!t) return;
    const d = new Date(t);
    const hourStart = Date.now() - (Date.now() % 3600_000);
    const hours = Math.round((d - hourStart) / 3600_000);
    const rel = Math.abs(hours) < 1 ? 'now' : `${hours > 0 ? '+' : ''}${hours}h`;
    els.timeLabel.textContent =
      `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · ${rel}`;
    onStatus(`☁ ECMWF IFS ${referenceTime?.slice(11, 13)}Z run (Open-Meteo) · wind flow: NOAA GFS`);
  }

  // --- Changes ------------------------------------------------------------------

  function setVariable(id) {
    settings.variable = id;
    save();
    if (!OM) return; // library still loading; it picks up settings.variable when ready
    updateLegend();
    applySource();
  }

  const applyTime = debounce(() => {
    applySource();
    loadWind();
  }, 200);

  function setTime(i) {
    timeIndex = Math.max(0, Math.min(validTimes.length - 1, i));
    els.time.value = timeIndex;
    updateTimeLabel();
    applyTime();
  }

  async function loadWind() {
    if (!settings.particles || !validTimes[timeIndex]) return;
    const at = validTimes[timeIndex];
    try {
      // The server snaps to GFS's 3-hourly steps; cache by that so scrubbing reuses fields.
      const key = new Date(Math.round(Date.parse(at) / 10_800_000) * 10_800_000).toISOString();
      let field = windCache.get(key);
      if (!field) {
        const res = await fetch(`/api/weather/wind?at=${encodeURIComponent(at)}`);
        field = await res.json();
        if (!res.ok) throw new Error(field.error || `HTTP ${res.status}`);
        windCache.set(key, field);
        if (windCache.size > 12) windCache.delete(windCache.keys().next().value);
      }
      if (enabled && validTimes[timeIndex] === at) particles.setField(field);
    } catch (err) {
      console.warn('Wind field failed:', err.message);
    }
  }

  function setPlaying(on) {
    clearInterval(playTimer);
    els.play.setAttribute('aria-pressed', String(on));
    els.play.textContent = on ? '❚❚' : '▶';
    if (on) {
      playTimer = setInterval(() => setTime(timeIndex + 1 >= validTimes.length ? 0 : timeIndex + 1), PLAY_EVERY_MS);
    }
  }

  // --- Map interaction ----------------------------------------------------------

  async function showForecast(lngLat) {
    popup?.remove();
    popup = new maplibregl.Popup({ className: 'wx-popup', maxWidth: '300px', focusAfterOpen: false })
      .setLngLat(lngLat)
      .setHTML('<div class="wx-pop wx-loading">Loading forecast…</div>')
      .addTo(map);
    const mine = popup;
    try {
      const res = await fetch(`/api/weather/forecast?lat=${lngLat.lat.toFixed(4)}&lon=${lngLat.lng.toFixed(4)}`);
      const f = await res.json();
      if (!res.ok) throw new Error(f.error || `HTTP ${res.status}`);
      if (popup === mine) mine.setHTML(forecastHtml(f, lngLat));
    } catch (err) {
      if (popup === mine) mine.setHTML(`<div class="wx-pop">Forecast unavailable: ${err.message}</div>`);
    }
  }

  const readValue = async (e) => {
    if (!enabled || !OM) return;
    try {
      const ll = e.lngLat.wrap();
      const res = await OM.getValueFromLatLong(ll.lat, ll.lng, omUrl(), map.getZoom());
      const v = typeof res === 'number' ? res : res?.value;
      const name = OVERLAYS.find((o) => o.id === settings.variable)?.name;
      onValue(Number.isFinite(v) ? `${name}: ${formatValue(v, scale?.unit || '')}` : '');
    } catch {
      onValue(''); // tile not loaded yet under the cursor
    }
  };
  let lastRead = 0;
  map.on('mousemove', (e) => {
    const now = performance.now();
    if (now - lastRead < 120) return;
    lastRead = now;
    readValue(e);
  });

  map.on('click', (e) => {
    if (!enabled) return;
    if (overlay.pick(e.point)) return; // a plane, satellite etc. took the click
    showForecast(e.lngLat);
  });

  els.time.addEventListener('input', () => setTime(Number(els.time.value)));
  els.play.addEventListener('click', () => setPlaying(els.play.getAttribute('aria-pressed') !== 'true'));
  els.particlesToggle.addEventListener('change', () => {
    settings.particles = els.particlesToggle.checked;
    save();
    particles.setRunning(enabled && settings.particles);
    loadWind();
  });

  buildOverlayButtons();
  els.particlesToggle.checked = settings.particles;

  // --- Public API -----------------------------------------------------------------

  return {
    setTheme() { /* palettes are dark-tuned for every theme; particles read --wind from CSS */ },
    async setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      els.bar.hidden = !on;
      if (!on) {
        setPlaying(false);
        clearInterval(metaTimer);
        removeSource();
        particles.setRunning(false);
        popup?.remove();
        onStatus('');
        onValue('');
        return;
      }
      onStatus('☁ Loading weather…');
      try {
        await loadLibrary();
        await loadMeta();
        if (!enabled) return;
        updateLegend();
        applySource();
        particles.setRunning(settings.particles);
        loadWind();
        metaTimer = setInterval(() => loadMeta().catch(() => {}), 30 * 60_000);
      } catch (err) {
        console.error(err);
        onStatus(`Weather failed to load: ${err.message}`);
      }
    },
  };
}
