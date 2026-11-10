// Weather data that needs a server.
//   wind     -> NOAA GFS 10 m wind (1° global grid) for animated particles. NOMADS
//               serves GRIB2 only, so we decode it here (lib/grib2.js). Public domain.
//   forecast -> Open-Meteo point forecast for the click popup (CC BY 4.0,
//               free for non-commercial use, ~10k calls/day).
// The colored overlays themselves load straight from Open-Meteo's S3 bucket in
// the browser (om:// protocol), so they don't go through here.

import { cached } from '../lib/cache.js';
import { fetchJson, HttpError } from '../lib/http.js';
import { decodeGrib2 } from '../lib/grib2.js';

const NOMADS_FILTER = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl';
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const HOUR = 3600_000;

// --- Wind (GFS) --------------------------------------------------------------------

const pad = (n, w = 2) => String(n).padStart(w, '0');

async function fetchGfsWind(run, fhour) {
  const ymd = `${run.getUTCFullYear()}${pad(run.getUTCMonth() + 1)}${pad(run.getUTCDate())}`;
  const hh = pad(run.getUTCHours());
  const params = new URLSearchParams({
    dir: `/gfs.${ymd}/${hh}/atmos`,
    file: `gfs.t${hh}z.pgrb2.1p00.f${pad(fhour, 3)}`,
    var_UGRD: 'on',
    var_VGRD: 'on',
    lev_10_m_above_ground: 'on',
  });
  const res = await fetch(`${NOMADS_FILTER}?${params}`, { signal: AbortSignal.timeout(30_000) });
  const buf = Buffer.from(await res.arrayBuffer());
  // NOMADS answers missing files with an HTML page, sometimes with status 200.
  if (!res.ok || buf.toString('ascii', 0, 4) !== 'GRIB') {
    throw new HttpError(res.status === 200 ? 404 : res.status, `GFS ${ymd}/${hh}z f${fhour} not available`);
  }
  const msgs = decodeGrib2(buf);
  const u = msgs.find((m) => m.category === 2 && m.parameter === 2);
  const v = msgs.find((m) => m.category === 2 && m.parameter === 3);
  if (!u || !v) throw new Error('GFS file is missing U or V wind');
  const round = (arr) => Array.from(arr, (x) => Math.round(x * 10) / 10);
  return {
    source: 'NOAA GFS',
    run: run.toISOString(),
    validTime: new Date(run.getTime() + fhour * HOUR).toISOString(),
    ...u.grid, // nx, ny, la1, lo1, dx, dy
    u: round(u.values),
    v: round(v.values),
  };
}

// Newest GFS run that's published. Runs are 00/06/12/18Z and appear ~4-5 h later.
function latestRun() {
  return cached('gfs:latest-run', 30 * 60_000, async () => {
    let t = Math.floor((Date.now() - 3.5 * HOUR) / (6 * HOUR)) * 6 * HOUR;
    for (let i = 0; i < 4; i++, t -= 6 * HOUR) {
      const run = new Date(t);
      try {
        await windFor(run, 0);
        return run.toISOString();
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    throw new HttpError(502, 'No recent GFS run found on NOMADS');
  });
}

function windFor(run, fhour) {
  return cached(`gfs:wind:${run.toISOString()}:${fhour}`, 6 * HOUR, () => fetchGfsWind(run, fhour));
}

// Wind valid nearest to `at` (ISO time, default now), from the latest run.
export async function wind(url) {
  const at = url.searchParams.get('at') ? Date.parse(url.searchParams.get('at')) : Date.now();
  if (!Number.isFinite(at)) throw new HttpError(400, 'bad time');
  const run = new Date(await latestRun());
  // 1° files are 3-hourly out to 384 h.
  const fhour = Math.min(384, Math.max(0, Math.round((at - run.getTime()) / (3 * HOUR)) * 3));
  return windFor(run, fhour);
}

// --- Point forecast (Open-Meteo) -------------------------------------------------------

const CURRENT = 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day';
const HOURLY = 'temperature_2m,precipitation_probability,precipitation,weather_code';
const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,sunrise,sunset';

export function forecast(url) {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (![lat, lon].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new HttpError(400, 'lat and lon are required');
  }
  // ~5 km buckets so nearby clicks share a cache entry.
  const qLat = Math.round(lat * 20) / 20;
  const qLon = Math.round(lon * 20) / 20;
  return cached(`forecast:${qLat},${qLon}`, 15 * 60_000, () => {
    const params = new URLSearchParams({
      latitude: qLat, longitude: qLon, current: CURRENT, hourly: HOURLY, daily: DAILY,
      timezone: 'auto', forecast_days: 7, forecast_hours: 25, wind_speed_unit: 'kmh',
    });
    return fetchJson(`${OPEN_METEO}?${params}`);
  });
}
