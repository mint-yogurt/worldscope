// Space data.
//   satellites -> CelesTrak "active" catalog as OMM JSON (~17k objects). CelesTrak
//                 refuses repeat downloads within ~2 h, so it's cached on disk for 6 h.
//                 We sort objects into categories ourselves from names and orbits.
//   aurora     -> NOAA SWPC OVATION aurora probability grid (30-90 min forecast).
//   summary    -> Kp index, solar wind, NOAA scales (G/S/R), latest alerts.
// NOAA data is US public domain; CelesTrak data is free with attribution.

import { cached, cachedOnDisk } from '../lib/cache.js';
import { fetchJson, HttpError } from '../lib/http.js';

const CELESTRAK_ACTIVE = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json';
const SWPC = 'https://services.swpc.noaa.gov';

// --- Satellites -----------------------------------------------------------------------

const CATEGORIES = [
  ['station', /^(ISS|TIANHE|WENTIAN|MENGTIAN|CSS)\b/],
  ['constellation', /^(STARLINK|ONEWEB|KUIPER|QIANFAN|GUOWANG|IRIDIUM|GLOBALSTAR|ORBCOMM)/],
  ['gnss', /NAVSTAR|GPS|GALILEO|GSAT0|GLONASS|BEIDOU|QZS|IRNSS|NAVIC/],
  ['weather', /NOAA|GOES|METEOSAT|METOP|HIMAWARI|FENGYUN|FY-|DMSP|JPSS|SUOMI|ELEKTRO|METEOR-M|GOMS/],
];

function categorize(o) {
  for (const [cat, re] of CATEGORIES) if (re.test(o.OBJECT_NAME)) return cat;
  // ~1 revolution per sidereal day = geosynchronous.
  if (Math.abs(o.MEAN_MOTION - 1.0027) < 0.05 && o.ECCENTRICITY < 0.05) return 'geo';
  return 'other';
}

// Just the OMM fields satellite.js's json2satrec needs, plus name/category.
const OMM_KEYS = ['OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'NORAD_CAT_ID', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];

export function satellites() {
  return cached('satellites:slim', 10 * 60_000, async () => {
    const all = await cachedOnDisk('celestrak-active', 6 * 3600_000, async () => {
      const res = await fetch(CELESTRAK_ACTIVE, { signal: AbortSignal.timeout(60_000) });
      const text = await res.text();
      // CelesTrak answers repeat downloads with a plain-text notice instead of data.
      if (!res.ok || !text.startsWith('[')) throw new HttpError(502, `CelesTrak: ${text.slice(0, 80).trim()}`);
      return JSON.parse(text);
    });
    return {
      source: 'CelesTrak',
      count: all.length,
      satellites: all.map((o) => ({
        ...Object.fromEntries(OMM_KEYS.map((k) => [k, o[k]])),
        category: categorize(o),
      })),
    };
  });
}

// --- Aurora ----------------------------------------------------------------------------

// Re-packed as a row-major grid from 90°N down to 90°S, 0°E eastward, 1° steps.
export function aurora() {
  return cached('swpc:aurora', 10 * 60_000, async () => {
    const d = await fetchJson(`${SWPC}/json/ovation_aurora_latest.json`);
    const values = new Array(360 * 181).fill(0);
    for (const [lon, lat, v] of d.coordinates) values[(90 - lat) * 360 + lon] = v;
    return {
      source: 'NOAA SWPC OVATION',
      observed: d['Observation Time'],
      forecast: d['Forecast Time'],
      nx: 360, ny: 181, la1: 90, lo1: 0,
      max: Math.max(...values),
      values,
    };
  });
}

// --- Summary card ----------------------------------------------------------------------

// Newest row from the spacecraft currently marked active (feeds mix several and aren't sorted the same way).
const latestActive = (rows) => {
  const sorted = [...rows].sort((a, b) => b.time_tag.localeCompare(a.time_tag));
  return sorted.find((r) => r.active) || sorted[0];
};

export function summary() {
  return cached('swpc:summary', 5 * 60_000, async () => {
    const get = (path) => fetchJson(`${SWPC}${path}`).catch((err) => {
      console.warn(`[space] ${path}: ${err.message}`);
      return null;
    });
    const [kp1m, kp3h, wind, mag, scales, alerts] = await Promise.all([
      get('/json/planetary_k_index_1m.json'),
      get('/products/noaa-planetary-k-index.json'),
      get('/json/rtsw/rtsw_wind_1m.json'),
      get('/json/rtsw/rtsw_mag_1m.json'),
      get('/products/noaa-scales.json'),
      get('/products/alerts.json'),
    ]);
    const w = wind && latestActive(wind);
    const m = mag && latestActive(mag);
    const now = scales?.['0'];
    return {
      kp: kp1m?.at(-1)?.estimated_kp ?? null,
      kp3h: kp3h?.at(-1)?.Kp ?? null,
      solarWind: w ? { speed: w.proton_speed, density: w.proton_density, time: w.time_tag } : null,
      bz: m ? m.bz_gsm : null,
      scales: now ? { G: now.G.Scale, S: now.S.Scale, R: now.R.Scale } : null,
      alerts: (alerts || []).slice(0, 3).map((a) => ({
        time: a.issue_datetime,
        // First meaningful line, e.g. "ALERT: Geomagnetic K-index of 5".
        title: (a.message.split(/\r?\n/).find((l) => /^(ALERT|WARNING|WATCH|SUMMARY|CONTINUED ALERT|EXTENDED WARNING)/.test(l)) || '').trim(),
      })),
    };
  });
}
