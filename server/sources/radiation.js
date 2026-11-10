// Radiation: ambient gamma dose rate from monitoring stations, in µSv/h.
//   BfS ODL (Germany): ~1,700 official stations, hourly averages. Open WFS.
//   STUK via FMI open data (Finland): ~250 official stations, 10-minute averages. CC BY 4.0.
//   Safecast realtime (worldwide): volunteer fixed sensors. CC0. They report
//     counts per minute; converted with Safecast's own factor per tube type.
// Fetched on demand and cached in memory; nothing is stored.

import { cached } from '../lib/cache.js';
import { fetchJson, HttpError, USER_AGENT } from '../lib/http.js';

const BFS = 'https://www.imis.bfs.de/ogc/opendata/ows';
const FMI = 'https://opendata.fmi.fi/wfs';
const SAFECAST_DEVICES = 'https://tt.safecast.org/devices';

// Tube -> counts per minute for 1 µSv/h. Other tube fields are skipped: their units
// are inconsistent across devices, so a converted value would be guesswork.
const SAFECAST_TUBES = { lnd_7318u: 334, lnd_7318c: 334, lnd_7128ec: 108 };
const SAFECAST_MAX_AGE = 24 * 3600_000; // live sensors only

const SOURCES = {
  bfs: { name: 'BfS (Germany)', url: 'https://odlinfo.bfs.de/' },
  stuk: { name: 'STUK / FMI (Finland)', url: 'https://www.stuk.fi/' },
  safecast: { name: 'Safecast', url: 'https://safecast.org/' },
};

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new HttpError(res.status, `${new URL(url).host} responded ${res.status}`);
  return res.text();
}

// --- Sources ---------------------------------------------------------------------

function bfsWfs(typeName, extra = {}) {
  const q = new URLSearchParams({ service: 'WFS', version: '1.1.0', request: 'GetFeature', typeName, outputFormat: 'application/json', ...extra });
  return `${BFS}?${q}`;
}

// BfS's GeoServer sometimes answers with an XML error (e.g. its database pool is
// busy) instead of JSON. Those pass quickly, so try a second time before giving up.
async function bfsJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchJson(url, { timeout: 45_000 });
    } catch (err) {
      const msg = err instanceof SyntaxError ? 'BfS server returned an error instead of data' : err.message;
      if (attempt >= 2) throw new HttpError(err.status || 502, msg);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function bfs() {
  return cached('rad:bfs', 20 * 60_000, async () => {
    const d = await bfsJson(bfsWfs('opendata:odlinfo_odl_1h_latest'));
    return d.features
      .filter((f) => Number.isFinite(f.properties.value) && f.properties.site_status === 1)
      .map((f) => {
        const p = f.properties;
        return {
          id: `bfs:${p.kenn}`, src: 'bfs', name: p.name, country: 'DE',
          lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
          value: p.value, at: Date.parse(p.end_measure),
          info: { heightM: p.height_above_sea, cosmic: p.value_cosmic, terrestrial: p.value_terrestrial, averaged: '1 hour' },
        };
      });
  });
}

// FMI answers in GML "multipoint coverage": station metadata, a list of
// "lat lon epoch" positions and a matching list of value tuples, in the same order.
function parseFmiCoverage(xml) {
  const stations = new Map(); // "lat lon" -> { id, name, region }
  for (const m of xml.matchAll(/<target:Location gml:id="obsloc-fmisid-(\d+)-pos">([\s\S]*?)<\/target:Location>/g)) {
    const name = m[2].match(/locationcode\/name">([^<]+)</)?.[1];
    const region = m[2].match(/location\/region">([^<]+)</)?.[1];
    const pos = xml.match(new RegExp(`<gml:Point gml:id="point-${m[1]}"[\\s\\S]*?<gml:pos>([^<]+)<`))?.[1].trim();
    if (pos) stations.set(pos.split(/\s+/).map(Number).join(' '), { id: m[1], name, region });
  }
  const positions = (xml.match(/<gmlcov:positions>([\s\S]*?)<\/gmlcov:positions>/)?.[1] || '').trim().split(/\n/);
  const values = (xml.match(/<gml:doubleOrNilReasonTupleList>([\s\S]*?)<\/gml:doubleOrNilReasonTupleList>/)?.[1] || '').trim().split(/\n/);
  return positions.map((line, i) => {
    const [lat, lon, epoch] = line.trim().split(/\s+/).map(Number);
    const value = Number(values[i]?.trim().split(/\s+/)[0]);
    return { lat, lon, at: epoch * 1000, value, station: stations.get(`${lat} ${lon}`) };
  }).filter((r) => Number.isFinite(r.value) && r.station);
}

function stuk() {
  return cached('rad:stuk', 10 * 60_000, async () => {
    const q = new URLSearchParams({
      service: 'WFS', version: '2.0.0', request: 'getFeature',
      storedquery_id: 'stuk::observations::external-radiation::latest::multipointcoverage',
    });
    return parseFmiCoverage(await fetchText(`${FMI}?${q}`)).map((r) => ({
      id: `stuk:${r.station.id}`, src: 'stuk', name: r.station.name, country: 'FI',
      lon: r.lon, lat: r.lat, value: r.value, at: r.at,
      info: { region: r.station.region, averaged: '10 minutes' },
    }));
  });
}

function safecast() {
  return cached('rad:safecast', 10 * 60_000, async () => {
    const devices = await fetchJson(SAFECAST_DEVICES, { timeout: 45_000 });
    const now = Date.now();
    const out = [];
    for (const d of devices) {
      const at = Date.parse(d.when_captured);
      if (!(now - at < SAFECAST_MAX_AGE) || !Number.isFinite(d.loc_lat) || !Number.isFinite(d.loc_lon)) continue;
      const tube = Object.keys(SAFECAST_TUBES).find((k) => Number.isFinite(d[k]) && d[k] > 0);
      if (!tube) continue;
      out.push({
        id: `safecast:${d.device}`, src: 'safecast',
        name: d.loc_name || d.device_sn || `Sensor ${d.device}`, country: d.loc_country || null,
        lon: d.loc_lon, lat: d.loc_lat,
        value: Math.round((d[tube] / SAFECAST_TUBES[tube]) * 1000) / 1000, at,
        info: { cpm: d[tube], tube: `LND ${tube.match(/\d+/)[0]}`, dashboard: d.dev_dashboard || null },
      });
    }
    return out;
  });
}

const LOADERS = { bfs, stuk, safecast };

// --- API -------------------------------------------------------------------------

// A slow source shouldn't hold up the others: answer without it after a while.
// Its request keeps going in the background and lands in the cache for next time.
const LIST_WAIT_MS = 12_000;
const deadline = (promise) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('still loading')), LIST_WAIT_MS).unref()),
]);

// GET /api/radiation -> every station's latest reading.
export async function list() {
  const ids = Object.keys(LOADERS);
  const results = await Promise.allSettled(ids.map((id) => deadline(LOADERS[id]())));
  const sources = [];
  const stations = [];
  results.forEach((r, i) => {
    const id = ids[i];
    if (r.status === 'fulfilled') {
      sources.push({ id, ...SOURCES[id], ok: true, count: r.value.length });
      stations.push(...r.value);
    } else {
      sources.push({ id, ...SOURCES[id], ok: false, error: r.reason.message });
      console.warn(`[radiation] ${id}: ${r.reason.message}`);
    }
  });
  if (!stations.length) throw new HttpError(502, 'No radiation source is responding right now');
  return { time: Date.now(), sources, stations };
}

// GET /api/radiation/:id/history -> the last week of readings, where the source keeps them.
export function history(id) {
  const [src, key] = id.split(':');
  if (src === 'bfs' && /^\d{9}$/.test(key)) {
    return cached(`rad:hist:${id}`, 30 * 60_000, async () => {
      const d = await bfsJson(bfsWfs('opendata:odlinfo_timeseries_odl_1h', {
        CQL_FILTER: `kenn='${key}'`, sortBy: 'end_measure D', maxFeatures: '168',
      }));
      const points = d.features
        .filter((f) => Number.isFinite(f.properties.value))
        .map((f) => [Date.parse(f.properties.end_measure), f.properties.value])
        .reverse();
      return { id, step: '1 hour', points };
    });
  }
  if (src === 'stuk' && /^\d+$/.test(key)) {
    return cached(`rad:hist:${id}`, 15 * 60_000, async () => {
      const q = new URLSearchParams({
        service: 'WFS', version: '2.0.0', request: 'getFeature',
        storedquery_id: 'stuk::observations::external-radiation::multipointcoverage',
        fmisid: key, timestep: '60',
        // FMI allows at most 168 hours; whole hours, rounded down, so ask for 167.
        starttime: new Date(Date.now() - 167 * 3600_000).toISOString().slice(0, 13) + ':00:00Z',
      });
      const points = parseFmiCoverage(await fetchText(`${FMI}?${q}`)).map((r) => [r.at, r.value]);
      return { id, step: '1 hour', points };
    });
  }
  if (src === 'safecast') return { id, step: null, points: [] };
  throw new HttpError(400, 'Unknown station');
}

// --- Safecast survey map tiles ----------------------------------------------------

// Safecast's own rendering of every measurement its volunteers have logged
// (mostly drives with mobile counters). Their tile bucket sends no CORS headers,
// so the browser can't load it directly; we pass tiles through untouched.
const SAFECAST_TILES = 'https://s3.amazonaws.com/te512.safecast.org';
const EMPTY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export async function safecastTile(z, x, y) {
  [z, x, y] = [z, x, y].map(Number);
  if (!(z >= 0 && z <= 16 && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z)) throw new HttpError(400, 'bad tile');
  const res = await fetch(`${SAFECAST_TILES}/${z}/${x}/${y}.png`, {
    headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000),
  });
  // Tiles where Safecast has nothing are 403/404: send a blank one instead of an error.
  if (res.status === 403 || res.status === 404) return EMPTY_PNG;
  if (!res.ok) throw new HttpError(res.status, `Safecast tiles responded ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
