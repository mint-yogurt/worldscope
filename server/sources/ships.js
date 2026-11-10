// Ships (AIS).
//   Digitraffic (Finnish Transport Infrastructure Agency): open REST feed of every
//     vessel its coastal receivers hear, Baltic Sea and around Finland. No key. Polled.
//   aisstream.io: worldwide terrestrial AIS over a WebSocket. Free key
//     (AISSTREAM_API_KEY); without it this source just stays off.
// Both feed one in-memory table keyed by MMSI, latest position wins. Nothing is
// written to disk: ships not heard from for a while are dropped.
// Both feeds sleep while nobody is viewing the site. See docs/server-impact.md.

import { fetchJson, HttpError } from '../lib/http.js';

const DIGITRAFFIC = 'https://meri.digitraffic.fi/api/ais/v1';
const AISSTREAM = 'wss://stream.aisstream.io/v0/stream';
const DIGITRAFFIC_HEADERS = { 'Digitraffic-User': 'WorldScope' };

// Drop ships silent for longer than this. Moored ships report rarely, so it's generous;
// the panel shows how old each position is.
const KEEP_MS = 3 * 3600_000;
// A moving ship's position goes stale much faster: after this it's left off the map.
const MOVING_MAX_AGE_MS = 30 * 60_000;
const TRAIL_POINTS = 40;
const TRAIL_EVERY_MS = 3 * 60_000;
const MAX_LIST = 20_000; // most ships sent for one view
const VESSELS_EVERY_MS = 15 * 60_000;
// Feeds stop this long after the last viewer. SHIPS_IDLE_MINUTES changes it.
const IDLE_MS = (Number(process.env.SHIPS_IDLE_MINUTES) || 10) * 60_000;
// After waking, the worldwide table takes about this long to fill back up.
const FILL_MS = 20 * 60_000;

const ships = new Map(); // mmsi -> record
let vesselsAt = 0;
const status = {
  digitraffic: { name: 'Digitraffic (Finland)', ok: null, at: 0, count: 0 },
  aisstream: { name: 'aisstream.io (worldwide)', ok: null, at: 0, count: 0, enabled: false },
};

// --- Ship types --------------------------------------------------------------------

// AIS "type of ship and cargo" code -> [category, name]. Categories drive map colors.
function shipType(code) {
  if (!Number.isFinite(code) || code <= 0) return ['other', null];
  const tens = Math.floor(code / 10);
  const special = {
    30: ['fishing', 'Fishing'], 31: ['service', 'Towing'], 32: ['service', 'Towing (large)'],
    33: ['service', 'Dredging / underwater ops'], 34: ['service', 'Diving ops'], 35: ['service', 'Military'],
    36: ['leisure', 'Sailing'], 37: ['leisure', 'Pleasure craft'],
    50: ['service', 'Pilot vessel'], 51: ['service', 'Search & rescue'], 52: ['service', 'Tug'],
    53: ['service', 'Port tender'], 54: ['service', 'Anti-pollution'], 55: ['service', 'Law enforcement'],
    58: ['service', 'Medical transport'], 59: ['service', 'Noncombatant ship'],
  };
  if (special[code]) return special[code];
  if (tens === 2) return ['other', 'Wing in ground'];
  if (tens === 4) return ['passenger', 'High-speed craft'];
  if (tens === 6) return ['passenger', 'Passenger'];
  if (tens === 7) return ['cargo', 'Cargo'];
  if (tens === 8) return ['tanker', 'Tanker'];
  if (tens === 9) return ['other', 'Other'];
  return ['other', null];
}

const NAV_STATUS = [
  'Under way', 'At anchor', 'Not under command', 'Restricted manoeuvrability',
  'Constrained by draught', 'Moored', 'Aground', 'Engaged in fishing', 'Sailing',
  null, null, 'Towing astern', 'Pushing ahead / towing alongside', null, 'AIS-SART (distress)', null,
];

// --- Table -------------------------------------------------------------------------

function ship(mmsi) {
  let s = ships.get(mmsi);
  if (!s) {
    s = { mmsi, trail: [] };
    ships.set(mmsi, s);
  }
  return s;
}

// `at` = ms when the position was measured. Older reports never overwrite newer ones.
function position(mmsi, { lat, lon, sog, cog, heading, nav, at, source }) {
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || (lat === 0 && lon === 0) || lat === 91) return;
  if (!(Date.now() - at < KEEP_MS)) return;
  const s = ship(mmsi);
  if (s.at && at <= s.at) return;
  const last = s.trail.at(-1);
  if (!last || at - last[2] >= TRAIL_EVERY_MS) {
    s.trail.push([lon, lat, at]);
    if (s.trail.length > TRAIL_POINTS) s.trail.shift();
  }
  Object.assign(s, {
    lat, lon, at, source,
    sog: Number.isFinite(sog) && sog < 102.3 ? sog : null,
    cog: Number.isFinite(cog) && cog < 360 ? cog : null,
    heading: Number.isFinite(heading) && heading < 360 ? heading : null,
    nav: Number.isFinite(nav) ? nav : s.nav ?? null,
  });
}

function statics(mmsi, d) {
  const s = ship(mmsi);
  s.seen = Date.now();
  for (const [k, v] of Object.entries(d)) {
    if (v == null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) continue;
    s[k] = typeof v === 'string' ? v.replace(/@+$/, '').trim() || s[k] : v;
  }
}

function prune() {
  const cutoff = Date.now() - KEEP_MS;
  // Static reports can arrive before the first position, so those count as being heard too.
  for (const [mmsi, s] of ships) if (Math.max(s.at || 0, s.seen || 0) < cutoff) ships.delete(mmsi);
}

// --- Digitraffic -------------------------------------------------------------------

async function pollDigitraffic() {
  const st = status.digitraffic;
  try {
    const d = await fetchJson(`${DIGITRAFFIC}/locations`, { headers: DIGITRAFFIC_HEADERS, timeout: 30_000 });
    for (const f of d.features || []) {
      const p = f.properties;
      const [lon, lat] = f.geometry.coordinates;
      position(f.mmsi, {
        lat, lon, sog: p.sog, cog: p.cog, heading: p.heading, nav: p.navStat,
        at: p.timestampExternal, source: 'digitraffic',
      });
    }
    Object.assign(st, { ok: true, error: null, at: Date.now() });
  } catch (err) {
    Object.assign(st, { ok: false, error: err.message, at: Date.now() });
    console.warn(`[ships] Digitraffic positions: ${err.message}`);
  }
}

async function pollDigitrafficVessels() {
  vesselsAt = Date.now();
  try {
    const list = await fetchJson(`${DIGITRAFFIC}/vessels`, { headers: DIGITRAFFIC_HEADERS, timeout: 30_000 });
    for (const v of list) {
      statics(v.mmsi, {
        name: v.name, callsign: v.callSign, imo: v.imo > 0 ? v.imo : null, type: v.shipType,
        destination: v.destination, draught: v.draught > 0 ? v.draught / 10 : null,
        length: v.referencePointA + v.referencePointB || null, beam: v.referencePointC + v.referencePointD || null,
        eta: digitrafficEta(v.eta),
      });
    }
  } catch (err) {
    console.warn(`[ships] Digitraffic vessels: ${err.message}`);
  }
}

function refreshDigitraffic() {
  pollDigitraffic();
  if (Date.now() - vesselsAt >= VESSELS_EVERY_MS) pollDigitrafficVessels();
}

// Digitraffic packs ETA as bits: month(4) day(5) hour(5) minute(6).
function digitrafficEta(n) {
  if (!n) return null;
  return etaText(n >> 16 & 0xf, n >> 11 & 0x1f, n >> 6 & 0x1f, n & 0x3f);
}

// AIS ETA has no year; keep it as "MM-DD HH:MM UTC" text, or null when unset.
function etaText(month, day, hour, minute) {
  if (!month || !day || month > 12 || day > 31) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(month)}-${p(day)}${hour < 24 && minute < 60 ? ` ${p(hour)}:${p(minute)}` : ''} UTC`;
}

// --- aisstream.io ------------------------------------------------------------------

let socket = null;
let retry = null; // timer for the next reconnect
let backoffMs = 5000;

function connectAisstream() {
  const key = process.env.AISSTREAM_API_KEY;
  const st = status.aisstream;
  if (!key) return;
  const ws = new WebSocket(AISSTREAM);
  ws.binaryType = 'arraybuffer';
  socket = ws;
  let received = 0;
  ws.addEventListener('open', () => {
    // Must be sent within 3 s of connecting, or the server closes the socket.
    ws.send(JSON.stringify({
      APIKey: key,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'],
    }));
  });
  ws.addEventListener('message', (e) => {
    let m;
    try {
      m = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8'));
    } catch {
      return;
    }
    if (m.error) {
      Object.assign(st, { ok: false, error: m.error, at: Date.now() });
      console.warn(`[ships] aisstream: ${m.error}`);
      return;
    }
    received++;
    if (received === 1) backoffMs = 5000;
    st.ok = true;
    st.error = null;
    st.at = Date.now();
    handleAisstream(m);
  });
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    socket = null;
    if (!received) Object.assign(st, { ok: false, error: st.error || 'connection closed', at: Date.now() });
    console.warn(`[ships] aisstream closed after ${received} messages; reconnecting in ${backoffMs / 1000}s`);
    retry = setTimeout(() => {
      retry = null;
      connectAisstream();
    }, backoffMs).unref();
    backoffMs = Math.min(backoffMs * 2, 5 * 60_000);
  });
  ws.addEventListener('error', () => { /* 'close' follows and handles reconnecting */ });
}

function handleAisstream(m) {
  const meta = m.MetaData || {};
  const mmsi = meta.MMSI;
  if (!mmsi) return;
  const body = m.Message?.[m.MessageType];
  if (!body) return;
  const at = Date.parse(String(meta.time_utc).replace(/\s\+0000 UTC$/, 'Z').replace(' ', 'T')) || Date.now();
  if (meta.ShipName) statics(mmsi, { name: meta.ShipName });
  switch (m.MessageType) {
    case 'PositionReport':
    case 'StandardClassBPositionReport':
    case 'ExtendedClassBPositionReport':
      position(mmsi, {
        lat: body.Latitude, lon: body.Longitude, sog: body.Sog, cog: body.Cog,
        heading: body.TrueHeading, nav: body.NavigationalStatus, at, source: 'aisstream',
      });
      if (m.MessageType === 'ExtendedClassBPositionReport') {
        statics(mmsi, { type: body.Type, ...dimensions(body.Dimension) });
      }
      break;
    case 'ShipStaticData':
      statics(mmsi, {
        name: body.Name, callsign: body.CallSign, imo: body.ImoNumber > 0 ? body.ImoNumber : null,
        type: body.Type, destination: body.Destination,
        draught: body.MaximumStaticDraught > 0 ? body.MaximumStaticDraught : null,
        eta: body.Eta ? etaText(body.Eta.Month, body.Eta.Day, body.Eta.Hour, body.Eta.Minute) : null,
        ...dimensions(body.Dimension),
      });
      break;
    case 'StaticDataReport':
      if (body.ReportA?.Valid) statics(mmsi, { name: body.ReportA.Name });
      if (body.ReportB?.Valid) {
        statics(mmsi, { type: body.ReportB.ShipType, callsign: body.ReportB.CallSign, ...dimensions(body.ReportB.Dimension) });
      }
      break;
  }
}

function dimensions(d) {
  if (!d) return {};
  return { length: d.A + d.B || null, beam: d.C + d.D || null };
}

// --- Sleep -------------------------------------------------------------------------

let awake = false;
let wokeAt = 0;
let lastViewer = 0;

// GET /api/presence: an open, visible page reports in every minute.
export function viewer() {
  lastViewer = Date.now();
  if (!awake) {
    awake = true;
    wokeAt = lastViewer;
    console.log('[ships] Viewer here, feeds on');
    refreshDigitraffic();
    if (!socket && !retry) connectAisstream();
  }
  return { ok: true };
}

function sleep() {
  awake = false;
  clearTimeout(retry);
  retry = null;
  const ws = socket;
  socket = null; // so the 'close' handler doesn't reconnect
  ws?.close();
  console.log(`[ships] No viewers for ${IDLE_MS / 60_000} min, feeds off`);
}

function tick() {
  if (!awake) return;
  if (Date.now() - lastViewer >= IDLE_MS) sleep();
  else refreshDigitraffic();
}

// --- Start & API -------------------------------------------------------------------

// Starts asleep: the feeds come on with the first viewer.
export function start() {
  status.aisstream.enabled = !!process.env.AISSTREAM_API_KEY;
  setInterval(tick, 60_000).unref();
  setInterval(prune, 5 * 60_000).unref();
}

// Every ship with a known position, for search and country counts.
export function* tracked() {
  for (const s of ships.values()) if (s.at) yield { ...s, category: shipType(s.type)[0], typeName: shipType(s.type)[1] };
}

// Category order for the size cap: moving commercial traffic is kept first.
const PRIORITY = { passenger: 0, tanker: 1, cargo: 2, service: 3, fishing: 4, leisure: 5, other: 6 };

// GET /api/ships?bbox=w,s,e,n -> compact rows for the map:
// [mmsi, lon, lat, course, speedKt, category, stopped(0/1), name, ageS]
export function list(url) {
  const bbox = (url.searchParams.get('bbox') || '-180,-90,180,90').split(',').map(Number);
  if (bbox.length !== 4 || !bbox.every(Number.isFinite)) throw new HttpError(400, 'bbox must be w,s,e,n');
  let [w, s, e, n] = bbox;
  const wrap = (lon) => ((lon + 540) % 360) - 180;
  const allLon = e - w >= 360;
  w = wrap(w);
  e = wrap(e);
  // w > e when the view crosses the antimeridian.
  const inLon = allLon ? () => true : w <= e ? (lon) => lon >= w && lon <= e : (lon) => lon >= w || lon <= e;
  const now = Date.now();
  let rows = [];
  status.digitraffic.count = status.aisstream.count = 0;
  for (const sh of ships.values()) {
    if (sh.at) status[sh.source].count++;
    if (!sh.at || sh.lat < s || sh.lat > n || !inLon(sh.lon)) continue;
    const [cat] = shipType(sh.type);
    const stopped = sh.nav === 1 || sh.nav === 5 || !(sh.sog >= 0.5);
    if (now - sh.at > (stopped ? KEEP_MS : MOVING_MAX_AGE_MS)) continue;
    // Under way, course over ground is measured; many ships leave heading unset at 0.
    rows.push([sh.mmsi, round(sh.lon, 5), round(sh.lat, 5), stopped ? sh.heading ?? sh.cog : sh.cog ?? sh.heading, sh.sog, cat, stopped ? 1 : 0, sh.name || null, Math.round((now - sh.at) / 1000)]);
  }
  const total = rows.length;
  if (rows.length > MAX_LIST) {
    rows = rows.sort((a, b) => a[6] - b[6] || PRIORITY[a[5]] - PRIORITY[b[5]]).slice(0, MAX_LIST);
  }
  const fillingUp = status.aisstream.enabled && now - wokeAt < FILL_MS;
  return { time: now, total, fillingUp, sources: Object.values(status), ships: rows };
}

// GET /api/ships/:mmsi -> everything known about one ship, plus its recent trail.
export function details(mmsi) {
  const s = ships.get(Number(mmsi));
  if (!s) throw new HttpError(400, 'Ship not currently tracked');
  const [category, typeName] = shipType(s.type);
  return {
    mmsi: s.mmsi, name: s.name || null, callsign: s.callsign || null, imo: s.imo || null,
    category, typeName, typeCode: s.type ?? null,
    lat: s.lat, lon: s.lon, sog: s.sog, cog: s.cog, heading: s.heading,
    nav: s.nav, navText: NAV_STATUS[s.nav] || null,
    destination: s.destination || null, eta: s.eta || null, draught: s.draught || null,
    length: s.length || null, beam: s.beam || null,
    at: s.at, source: s.source,
    trail: s.trail.map(([lon, lat]) => [lon, lat]),
  };
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
