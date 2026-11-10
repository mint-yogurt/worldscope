// Radio, all fetched only while someone has the layer on.
//   SDR receivers: Receiverbook's map page (OpenWebRX, WebSDR, KiwiSDR sites) merged
//     with the KiwiSDR list, which adds who's on them right now. Receiverbook has no
//     API: its list is read from a script in the page, so this breaks if the page changes.
//   Internet radio: Radio Browser, the stations with a position and a working stream.
//   Propagation: WSPR spots from wspr.live, a sample of the paths of the last 15 minutes.

import { createHash } from 'node:crypto';
import { cached, cachedOnDisk } from '../lib/cache.js';
import { fetchJson, HttpError, USER_AGENT } from '../lib/http.js';

const RECEIVERBOOK = 'https://www.receiverbook.de/map';
const KIWI_LIST = 'http://rx.linkfanel.net/kiwisdr_com.js';
const RADIO_SERVERS = 'https://all.api.radio-browser.info/json/servers';
const RADIO_FALLBACK = 'de1.api.radio-browser.info';
const WSPR = 'https://db1.wspr.live/';
// Paths sent to the map. The full 15 minutes is about 60,000 spots.
const WSPR_PATHS = 5000;
const WSPR_BANDS = [1, 3, 5, 7, 10, 14, 18, 21, 24, 28, 50];

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new HttpError(res.status, `${new URL(url).host} responded ${res.status}`);
  return res.text();
}

const webUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : null);
const urlKey = (u) => u.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
const number = (v) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : null);

// These lists are written for HTML: drop tags and decode entities.
function plain(s) {
  return String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (m, n) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : ''))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- SDR receivers -----------------------------------------------------------------

function receiverbookSites() {
  return cachedOnDisk('receiverbook', 24 * 3600_000, async () => {
    const page = await fetchText(RECEIVERBOOK);
    const m = page.match(/var receivers = (\[.*?\]);\s*$/m);
    if (!m) throw new Error('Receiverbook page layout changed');
    return JSON.parse(m[1]).map((site) => ({
      name: plain(site.label),
      lon: site.location.coordinates[0],
      lat: site.location.coordinates[1],
      receivers: site.receivers.filter((r) => webUrl(r.url)).map((r) => ({
        type: r.type, name: plain(r.label), url: r.url, version: r.version || null,
      })),
    })).filter((s) => s.receivers.length && Number.isFinite(s.lon) && Number.isFinite(s.lat));
  });
}

function bandsText(bands) {
  const [lo, hi] = String(bands).split('-').map(Number);
  return Number.isFinite(lo) && hi ? `${Math.round(lo / 1e5) / 10}–${Math.round(hi / 1e5) / 10} MHz` : null;
}

// The file is a script: `var kiwisdr_com = [ ... , ]`, with a comma JSON doesn't allow.
async function kiwiList() {
  const body = await fetchText(KIWI_LIST);
  const list = JSON.parse(`${body.slice(body.indexOf('['), body.lastIndexOf(']')).trimEnd().replace(/,$/, '')}]`);
  return list.filter((k) => k.offline === 'no' && webUrl(k.url)).map((k) => {
    const gps = String(k.gps).match(/(-?[\d.]+),\s*(-?[\d.]+)/);
    return {
      url: k.url,
      name: plain(k.name),
      lat: gps ? Number(gps[1]) : null,
      lon: gps ? Number(gps[2]) : null,
      live: {
        users: number(k.users),
        max: number(k.users_max),
        antenna: plain(k.antenna) || null,
        snr: number(String(k.snr).split(',')[0]),
        bands: bandsText(k.bands),
      },
    };
  });
}

const siteId = (url) => `sdr:${createHash('sha1').update(urlKey(url)).digest('hex').slice(0, 12)}`;

export function receivers() {
  return cached('radio:receivers', 30 * 60_000, async () => {
    const [book, kiwi] = await Promise.allSettled([receiverbookSites(), kiwiList()]);
    if (book.status === 'rejected') console.warn(`[radio] Receiverbook: ${book.reason.message}`);
    if (kiwi.status === 'rejected') console.warn(`[radio] KiwiSDR list: ${kiwi.reason.message}`);
    if (book.status === 'rejected' && kiwi.status === 'rejected') throw book.reason;
    const kiwis = new Map((kiwi.value || []).map((k) => [urlKey(k.url), k]));
    const sites = (book.value || []).map((site) => ({
      ...site,
      receivers: site.receivers.map((r) => {
        const k = kiwis.get(urlKey(r.url));
        kiwis.delete(urlKey(r.url));
        return k ? { ...r, ...k.live } : r;
      }),
    }));
    for (const k of kiwis.values()) {
      if (!Number.isFinite(k.lat) || !Number.isFinite(k.lon)) continue;
      sites.push({ name: k.name, lon: k.lon, lat: k.lat, receivers: [{ type: 'KiwiSDR', name: k.name, url: k.url, ...k.live }] });
    }
    return {
      // A few receivers are listed under two sites; the first one keeps them.
      sites: [...new Map(sites.map((s) => [siteId(s.receivers[0].url), s])).entries()].map(([id, s]) => ({ id, ...s })),
      sources: [
        { name: 'Receiverbook', url: 'https://www.receiverbook.de/', ok: book.status === 'fulfilled', count: book.value?.length ?? 0 },
        { name: 'KiwiSDR list', url: 'http://rx.linkfanel.net/', ok: kiwi.status === 'fulfilled', count: kiwi.value?.length ?? 0 },
      ],
    };
  });
}

// --- Internet radio ----------------------------------------------------------------

async function radioHost() {
  try {
    const list = await fetchJson(RADIO_SERVERS, { timeout: 8000 });
    return list[0]?.name || RADIO_FALLBACK;
  } catch {
    return RADIO_FALLBACK;
  }
}

function stationTable() {
  return cachedOnDisk('radio-stations', 24 * 3600_000, async () => {
    const host = await radioHost();
    const q = new URLSearchParams({ has_geo_info: 'true', hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: '100000' });
    const list = await fetchJson(`https://${host}/json/stations/search?${q}`, { timeout: 90_000 });
    // HLS streams need a player library, so they're left out.
    return list.filter((s) => !s.hls && webUrl(s.url_resolved) && Math.abs(s.geo_lat) <= 90 && Math.abs(s.geo_long) <= 180).map((s) => ({
      id: `fm:${s.stationuuid.replaceAll('-', '').slice(0, 12)}`,
      name: plain(s.name),
      lon: Math.round(s.geo_long * 1e4) / 1e4,
      lat: Math.round(s.geo_lat * 1e4) / 1e4,
      clicks: s.clickcount,
      votes: s.votes,
      tags: s.tags ? s.tags.split(',').slice(0, 6).join(', ') : null,
      country: s.country || null,
      language: s.language || null,
      codec: s.codec || null,
      bitrate: s.bitrate || null,
      stream: s.url_resolved,
      home: webUrl(s.homepage),
    }));
  });
}

let stationIndex = { table: null, byId: new Map() };
async function stationMap() {
  const table = await stationTable();
  if (stationIndex.table !== table) stationIndex = { table, byId: new Map(table.map((s) => [s.id, s])) };
  return stationIndex.byId;
}

export const allStations = stationTable;

// GET /api/radio/stations -> rows for the map: [id, name, lon, lat, clicks]
export async function stations() {
  const table = await stationTable();
  return { stations: table.map((s) => [s.id, s.name, s.lon, s.lat, s.clicks]) };
}

// GET /api/radio/stations/:id
export async function station(id) {
  const s = (await stationMap()).get(id);
  if (!s) throw new HttpError(400, 'Station not found');
  return s;
}

// --- Propagation -------------------------------------------------------------------

// GET /api/radio/wspr -> paths heard in the last 15 minutes, a stable sample of them:
// [txSign, txLon, txLat, rxSign, rxLon, rxLat, bandMHz, km, snrDb, powerDbm]
export function wspr() {
  return cached('radio:wspr', 3 * 60_000, async () => {
    const sql = `SELECT tx_sign, tx_lon, tx_lat, rx_sign, rx_lon, rx_lat, band, distance, snr, power
      FROM wspr.rx
      WHERE time > now() - INTERVAL 15 MINUTE AND band IN (${WSPR_BANDS.join(',')}) AND distance >= 200
      ORDER BY cityHash64(tx_sign, rx_sign)
      LIMIT 1 BY tx_sign, rx_sign, band
      LIMIT ${WSPR_PATHS}
      FORMAT JSONCompact`;
    const d = await fetchJson(`${WSPR}?query=${encodeURIComponent(sql)}`, { timeout: 20_000 });
    return { time: Date.now(), paths: d.data };
  });
}
