// Webcams, fetched only while someone has the layer on.
//   Windy Webcams (WINDY_WEBCAMS_API_KEY): about 69,000 cameras. The free tier only lists
//     the top of any search, so the world is split into cells, one request each, and
//     a closer view uses smaller cells. Only positions and titles are kept, in memory.
//     Windy's terms limit image use, so the browser embeds their player instead.
//   Open road cameras: Digitraffic (Finland) and Caltrans (California), no key.

import { cached, cachedOnDisk, throttle } from '../lib/cache.js';
import { fetchJson, HttpError } from '../lib/http.js';

const WINDY = 'https://api.windy.com/webcams/api/v3/webcams';
const DIGITRAFFIC = 'https://tie.digitraffic.fi/api/weathercam/v1/stations';
const DIGITRAFFIC_HEADERS = { 'Digitraffic-User': 'WorldScope' };
const CALTRANS_DISTRICTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const CELL_LEVELS = [3, 11]; // a cell is 360 / 2^level degrees wide
const MAX_CELLS = 32; // Windy requests for one view, before anything is cached
// Windy doesn't publish its limit, and 4 requests a second tripped it within a minute.
const windyGate = throttle(600);
const WINDY_WAIT_MS = 1500; // a view gets what's ready by then; the page asks again for the rest
const WINDY_PAUSE_MS = 60_000; // after a rate limit, unless Windy says how long
let windyPausedUntil = 0;
const windySeen = new Map(); // id -> row, for search and links

const windyKey = () => process.env.WINDY_WEBCAMS_API_KEY;
const windyHeaders = () => ({ 'x-windy-api-key': windyKey() });

// --- Windy -------------------------------------------------------------------------

function windyCell(level, col, row) {
  const size = 360 / 2 ** level;
  const west = -180 + col * size;
  const south = -90 + row * size;
  return cached(`windy:${level}:${col}:${row}`, 24 * 3600_000, async () => {
    const q = new URLSearchParams({
      limit: '50', include: 'location', bbox: [south + size, west + size, south, west].join(','),
    });
    const paused = () => Date.now() < windyPausedUntil;
    if (paused()) throw new Error('Windy rate limit, waiting');
    const d = await windyGate(async () => {
      // Requests already queued stop here too, so a rate limit isn't made worse.
      if (paused()) throw new Error('Windy rate limit, waiting');
      try {
        return await fetchJson(`${WINDY}?${q}`, { headers: windyHeaders() });
      } catch (err) {
        if (err.status === 429) windyPausedUntil = Date.now() + (err.retryAfter ? err.retryAfter * 1000 : WINDY_PAUSE_MS);
        throw err;
      }
    });
    const cams = d.webcams.filter((c) => c.status === 'active' && c.location).map((c) => {
      const cam = { id: `windy:${c.webcamId}`, src: 'windy', name: c.title, lon: c.location.longitude, lat: c.location.latitude };
      windySeen.set(cam.id, cam);
      return cam;
    });
    return { total: d.total, cams };
  });
}

// The cells covering a view, using larger ones until there are few enough.
function cellsFor(w, s, e, n, zoom) {
  const [minLevel, maxLevel] = CELL_LEVELS;
  const south = Math.max(s, -90);
  const north = Math.min(n, 89.999);
  for (let level = Math.min(maxLevel, Math.max(minLevel, Math.round(zoom) + 1)); ; level--) {
    const count = 2 ** level;
    const size = 360 / count;
    const cols = e - w >= 360 ? count : Math.floor((e + 180) / size) - Math.floor((w + 180) / size) + 1;
    const rows = Math.floor((north + 90) / size) - Math.floor((south + 90) / size) + 1;
    if (cols * rows > MAX_CELLS && level > minLevel) continue;
    const out = [];
    const firstCol = Math.floor((w + 180) / size);
    const firstRow = Math.floor((south + 90) / size);
    for (let c = 0; c < Math.min(cols, count); c++) {
      for (let r = 0; r < rows; r++) out.push([level, (((firstCol + c) % count) + count) % count, firstRow + r]);
    }
    return out;
  }
}

// --- Open road cameras -------------------------------------------------------------

async function digitrafficCams() {
  const d = await fetchJson(DIGITRAFFIC, { headers: DIGITRAFFIC_HEADERS, timeout: 30_000 });
  return d.features.filter((f) => f.properties.collectionStatus === 'GATHERING').map((f) => ({
    id: `fi:${f.id}`,
    src: 'fi',
    // "kt51_Inkoo" -> "Inkoo, road 51"
    name: f.properties.name.replace(/^[a-z]+(\d+)_(.+)$/i, '$2, road $1').replaceAll('_', ' '),
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));
}

async function caltransCams() {
  const url = (d) => `https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${String(d).padStart(2, '0')}.json`;
  const districts = await Promise.allSettled(CALTRANS_DISTRICTS.map((d) => fetchJson(url(d), { timeout: 30_000 })));
  const cams = [];
  for (const result of districts) {
    if (result.status === 'rejected') {
      console.warn(`[webcams] Caltrans: ${result.reason.message}`);
      continue;
    }
    for (const { cctv: c } of result.value.data) {
      const image = c.imageData?.static?.currentImageURL;
      const slug = image?.match(/\/([^/]+)\.jpg$/i)?.[1];
      const lon = Number(c.location.longitude);
      const lat = Number(c.location.latitude);
      if (c.inService !== 'true' || !slug || !lon || !lat) continue;
      cams.push({
        id: `ca:${c.location.district}-${slug}`, src: 'ca', name: c.location.locationName, lon, lat,
        image, county: c.location.county, route: c.location.route, direction: c.location.direction,
      });
    }
  }
  if (!cams.length) throw new Error('Caltrans returned no cameras');
  return cams;
}

function openCams() {
  return cachedOnDisk('open-webcams', 6 * 3600_000, async () => {
    const [fi, ca] = await Promise.allSettled([digitrafficCams(), caltransCams()]);
    if (fi.status === 'rejected' && ca.status === 'rejected') throw fi.reason;
    return [...(fi.value || []), ...(ca.value || [])];
  });
}

// --- API ---------------------------------------------------------------------------

const inBox = (w, s, e, n) => {
  if (e - w >= 360) return (c) => c.lat >= s && c.lat <= n;
  const wrap = (lon) => ((lon + 540) % 360) - 180;
  const [a, b] = [wrap(w), wrap(e)];
  return (c) => c.lat >= s && c.lat <= n && (a <= b ? c.lon >= a && c.lon <= b : c.lon >= a || c.lon <= b);
};

// GET /api/webcams?bbox=w,s,e,n&zoom=z -> rows: [id, source, name, lon, lat]
export async function list(url) {
  const bbox = (url.searchParams.get('bbox') || '-180,-90,180,90').split(',').map(Number);
  const zoom = Number(url.searchParams.get('zoom')) || 2;
  if (bbox.length !== 4 || !bbox.every(Number.isFinite)) throw new HttpError(400, 'bbox must be w,s,e,n');
  const [w, s, , n] = bbox;
  // East is behind west when the view crosses the antimeridian.
  const e = bbox[2] < w ? bbox[2] + 360 : bbox[2];
  const sources = [];

  let open = [];
  try {
    open = (await openCams()).filter(inBox(w, s, e, n));
    sources.push({ id: 'open', ok: true });
  } catch (err) {
    console.warn(`[webcams] Road cameras: ${err.message}`);
    sources.push({ id: 'open', ok: false, error: err.message });
  }

  let windy = [];
  let windyTotal = 0;
  let pending = false;
  if (windyKey()) {
    const wanted = cellsFor(w, s, e, n, zoom);
    const good = [];
    let failed = null;
    let settled = 0;
    const loads = wanted.map(([l, c, r]) => windyCell(l, c, r)
      .then((cell) => good.push(cell), (err) => { failed = err; })
      .finally(() => { settled++; }));
    await Promise.race([Promise.all(loads), new Promise((resolve) => setTimeout(resolve, WINDY_WAIT_MS))]);
    pending = settled < wanted.length;
    windy = good.flatMap((c) => c.cams);
    windyTotal = good.reduce((sum, c) => sum + c.total, 0);
    if (failed) console.warn(`[webcams] Windy: ${failed.message}`);
    sources.push({ id: 'windy', ok: !failed, error: failed?.message });
  } else {
    sources.push({ id: 'windy', ok: false, error: 'No WINDY_WEBCAMS_API_KEY on the server' });
  }

  // Windy last, so its dots draw on top: it lists many of the same road cameras.
  const rows = [...open, ...windy].map((c) => [c.id, c.src, c.name, c.lon, c.lat]);
  return { time: Date.now(), windyTotal, pending, sources, webcams: rows };
}

function windyDetails(id) {
  return cached(`windy-cam:${id}`, 3600_000, async () => {
    const c = await fetchJson(`${WINDY}/${id}?include=location,player,urls`, { headers: windyHeaders() });
    const l = c.location;
    return {
      id: `windy:${id}`, src: 'windy', name: c.title, lon: l.longitude, lat: l.latitude,
      place: [l.city, l.region, l.country].filter(Boolean).join(', '),
      updated: c.lastUpdatedOn, player: c.player?.day || null, url: c.urls?.detail || `https://windy.com/webcams/${id}`,
    };
  });
}

function digitrafficDetails(id) {
  return cached(`fi-cam:${id}`, 10 * 60_000, async () => {
    const d = await fetchJson(`${DIGITRAFFIC}/${id}`, { headers: DIGITRAFFIC_HEADERS });
    const p = d.properties;
    return {
      id: `fi:${id}`, src: 'fi', name: p.names?.en || p.names?.fi || p.name,
      lon: d.geometry.coordinates[0], lat: d.geometry.coordinates[1],
      place: [p.municipality, p.province, 'Finland'].filter(Boolean).join(', '),
      updated: p.dataUpdatedTime,
      views: p.presets.filter((v) => v.inCollection && v.imageUrl).map((v) => ({
        name: v.presentationName || v.id, image: v.imageUrl,
      })),
    };
  });
}

// GET /api/webcams/:id
export async function details(id) {
  const [, source, key] = id.match(/^(windy|fi|ca):([\w-]+)$/) || [];
  if (source === 'windy' && /^\d+$/.test(key) && windyKey()) return windyDetails(key);
  if (source === 'fi') return digitrafficDetails(key);
  if (source === 'ca') {
    const c = (await openCams()).find((x) => x.id === id);
    if (c) {
      return {
        id, src: 'ca', name: c.name, lon: c.lon, lat: c.lat,
        place: [c.route, c.county && `${c.county} County`, 'California'].filter(Boolean).join(', '),
        direction: c.direction, views: [{ name: c.direction ? `Facing ${c.direction.toLowerCase()}` : 'Live image', image: c.image }],
      };
    }
  }
  throw new HttpError(400, 'Webcam not found');
}

// For search: road cameras, plus every Windy camera already loaded for a view.
export async function known() {
  return [...(await openCams()), ...windySeen.values()];
}
