// Flight data.
//   Zoomed in  -> live ADS-B around a point (<= 250 nm) from adsb.lol, falling back to
//                 airplanes.live when rate-limited. Refreshed every few seconds.
//   Zoomed out -> OpenSky global snapshot. Anonymous: ~100 calls/day, so it's cached 15 min.
//                 With OPENSKY_CLIENT_ID/SECRET (free account) it refreshes every 90 s.
//   On click   -> adsb.lol trace (path flown so far), adsbdb route + aircraft details.
// Both live sources are normalized to the same compact record (see `aircraft()`).

import { cached, throttle } from '../lib/cache.js';
import { fetchJson, HttpError } from '../lib/http.js';

const ADSBLOL_TRACES = 'https://adsb.lol/data/traces';
const OPENSKY = 'https://opensky-network.org/api';
const OPENSKY_TOKEN = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const ADSBDB = 'https://api.adsbdb.com/v0';

// Live point queries, in order of preference. Same response format (ADSBExchange v2).
// A provider that rate-limits or fails is skipped until its cool-down ends.
const LIVE_PROVIDERS = [
  { name: 'adsb.lol', base: 'https://api.adsb.lol/v2/point', queue: throttle(1000), blockedUntil: 0 },
  { name: 'airplanes.live', base: 'https://api.airplanes.live/v2/point', queue: throttle(1100), blockedUntil: 0 },
];

async function fetchPoint(lat, lon, r) {
  let lastErr;
  for (const p of LIVE_PROVIDERS) {
    if (p.blockedUntil > Date.now()) continue;
    try {
      return { provider: p.name, data: await p.queue(() => fetchJson(`${p.base}/${lat}/${lon}/${r}`)) };
    } catch (err) {
      lastErr = err;
      p.blockedUntil = Date.now() + (err.retryAfter || 60) * 1000;
      console.warn(`[flights] ${p.name} failed (${err.message}); pausing it for ${err.retryAfter || 60}s`);
    }
  }
  throw lastErr || new HttpError(503, 'Live flight sources are cooling down after rate limits; retrying shortly');
}

const M_TO_FT = 3.28084;
const MS_TO_KT = 1.94384;

// Compact record sent to the browser. alt in feet (null if unknown), gs knots,
// track degrees, vr ft/min, age = seconds since the position was measured.
function aircraft(o) {
  return {
    hex: o.hex,
    flight: o.flight?.trim() || null,
    reg: o.reg || null,
    type: o.type || null,
    lat: o.lat,
    lon: o.lon,
    alt: o.alt ?? null,
    ground: !!o.ground,
    gs: o.gs ?? null,
    track: o.track ?? null,
    vr: o.vr ?? null,
    squawk: o.squawk || null,
    emergency: o.emergency && o.emergency !== 'none' ? o.emergency : null,
    mil: !!o.mil,
    age: Math.max(0, Math.round((o.age ?? 0) * 10) / 10),
  };
}

// One aircraft from an ADSBExchange v2 response.
const fromLive = (a) => aircraft({
  hex: a.hex, flight: a.flight, reg: a.r, type: a.t, lat: a.lat, lon: a.lon,
  ground: a.alt_baro === 'ground',
  alt: typeof a.alt_baro === 'number' ? a.alt_baro : a.alt_geom,
  gs: a.gs, track: a.track ?? a.true_heading, vr: a.baro_rate ?? a.geom_rate,
  squawk: a.squawk, emergency: a.emergency, mil: (a.dbFlags & 1) === 1, age: a.seen_pos,
});

// --- Live around a point (adsb.lol) ---------------------------------------------

export async function live(url) {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  const r = Number(url.searchParams.get('r'));
  if (![lat, lon, r].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new HttpError(400, 'lat, lon and r (nautical miles) are required');
  }
  // Snap the query so nearby viewers/pans share cache entries; pad the radius to cover the snap.
  const step = r > 100 ? 0.5 : 0.1;
  const qLat = Math.round(lat / step) * step;
  const qLon = Math.round(lon / step) * step;
  const qR = Math.min(250, Math.ceil((r + step * 60) / 25) * 25);
  const key = `live:${qLat.toFixed(1)},${qLon.toFixed(1)},${qR}`;

  return cached(key, 4000, async () => {
    const { provider, data: d } = await fetchPoint(qLat.toFixed(2), qLon.toFixed(2), qR);
    const list = (d.ac || [])
      .filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon))
      .map(fromLive);
    return { source: provider, time: d.now || Date.now(), center: [qLon, qLat], radiusNm: qR, aircraft: list };
  });
}

// --- Emergency squawks ---------------------------------------------------------

const SQUAWK_MAX_AGE_S = 120;

// Airborne aircraft worldwide squawking an emergency code. adsb.lol's own queue keeps
// these three requests apart. airplanes.live refuses this lookup, so there's no fallback.
export function squawking() {
  return cached('flights:squawks', 60_000, async () => {
    const adsbLol = LIVE_PROVIDERS[0];
    const found = [];
    for (const code of ['7700', '7500', '7600']) {
      const d = await adsbLol.queue(() => fetchJson(`https://api.adsb.lol/v2/sqk/${code}`));
      found.push(...(d.ac || []).filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon)).map(fromLive));
    }
    return found.filter((a) => !a.ground && a.age < SQUAWK_MAX_AGE_S);
  });
}

// --- Whole world (OpenSky) -------------------------------------------------------

let token = null; // { value, expires }

async function openskyAuth() {
  const id = process.env.OPENSKY_CLIENT_ID;
  const secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return {};
  if (!token || token.expires < Date.now() + 60_000) {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret });
    const t = await fetchJson(OPENSKY_TOKEN, {
      method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    token = { value: t.access_token, expires: Date.now() + (t.expires_in || 1800) * 1000 };
  }
  return { Authorization: `Bearer ${token.value}` };
}

export function world() {
  const authed = !!(process.env.OPENSKY_CLIENT_ID && process.env.OPENSKY_CLIENT_SECRET);
  return cached('opensky:world', authed ? 90_000 : 15 * 60_000, async () => {
    const d = await fetchJson(`${OPENSKY}/states/all`, { headers: await openskyAuth(), timeout: 30_000 });
    const now = d.time;
    // State vector layout: https://openskynetwork.github.io/opensky-api/rest.html#all-state-vectors
    const list = (d.states || [])
      .filter((s) => Number.isFinite(s[5]) && Number.isFinite(s[6]))
      .map((s) => aircraft({
        hex: s[0], flight: s[1], lat: s[6], lon: s[5], ground: s[8],
        alt: Number.isFinite(s[7] ?? s[13]) ? Math.round((s[7] ?? s[13]) * M_TO_FT) : null,
        gs: Number.isFinite(s[9]) ? Math.round(s[9] * MS_TO_KT * 10) / 10 : null,
        track: s[10], vr: Number.isFinite(s[11]) ? Math.round(s[11] * M_TO_FT * 60) : null,
        squawk: s[14], emergency: ['7500', '7600', '7700'].includes(s[14]) ? 'squawk' : null,
        age: now - (s[3] ?? now),
      }));
    return { source: 'opensky', time: now * 1000, authenticated: authed, aircraft: list };
  });
}

// --- Selected aircraft: path flown so far (adsb.lol trace) -------------------------

const HEX_RE = /^~?[0-9a-f]{6}$/i;

export function trace(hex) {
  hex = hex.toLowerCase();
  if (!HEX_RE.test(hex)) throw new HttpError(400, 'bad hex');
  return cached(`trace:${hex}`, 30_000, async () => {
    let d;
    try {
      d = await fetchJson(`${ADSBLOL_TRACES}/${hex.slice(-2)}/trace_full_${hex}.json`);
    } catch (err) {
      if (err.status === 404) return { hex, points: [] };
      throw err;
    }
    // Each point: [secondsAfterTimestamp, lat, lon, alt|'ground', gs, track, flags, ...].
    // Walk back from the newest point to the start of the current leg:
    // a leg flag (bit 2), a ground point, or a gap of more than 20 minutes.
    const pts = d.trace || [];
    let start = pts.length - 1;
    while (start > 0) {
      const p = pts[start];
      const prev = pts[start - 1];
      if (p[6] & 2 || prev[3] === 'ground' || p[0] - prev[0] > 20 * 60) break;
      start--;
    }
    const leg = pts.slice(start);
    const every = Math.max(1, Math.ceil(leg.length / 600));
    const points = leg
      .filter((p, i) => i % every === 0 || i === leg.length - 1)
      .map((p) => [p[2], p[1], typeof p[3] === 'number' ? p[3] : 0, Math.round((d.timestamp + p[0]) * 1000)]);
    return { hex, points };
  });
}

// --- Route + aircraft details (adsbdb). Looked up live, never stored. ---------------

function airport(a) {
  return a && {
    iata: a.iata_code, icao: a.icao_code, name: a.name, city: a.municipality,
    country: a.country_name, lat: a.latitude, lon: a.longitude,
  };
}

export function route(callsign) {
  callsign = callsign.toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(callsign)) throw new HttpError(400, 'bad callsign');
  return cached(`route:${callsign}`, 6 * 60 * 60_000, async () => {
    try {
      const d = await fetchJson(`${ADSBDB}/callsign/${callsign}`);
      const r = d.response?.flightroute;
      if (!r) return { callsign, route: null };
      return {
        callsign,
        route: {
          airline: r.airline?.name || null,
          origin: airport(r.origin),
          destination: airport(r.destination),
        },
      };
    } catch (err) {
      if (err.status === 404) return { callsign, route: null };
      throw err;
    }
  });
}

export function details(hex) {
  hex = hex.toLowerCase();
  if (!HEX_RE.test(hex)) throw new HttpError(400, 'bad hex');
  return cached(`aircraft:${hex}`, 24 * 60 * 60_000, async () => {
    try {
      const a = (await fetchJson(`${ADSBDB}/aircraft/${hex.replace('~', '')}`)).response?.aircraft;
      if (!a) return { hex, aircraft: null };
      return {
        hex,
        aircraft: {
          type: a.type, icaoType: a.icao_type, manufacturer: a.manufacturer,
          reg: a.registration, owner: a.registered_owner, country: a.registered_owner_country_name,
          photo: a.url_photo, thumb: a.url_photo_thumbnail,
        },
      };
    } catch (err) {
      if (err.status === 404) return { hex, aircraft: null };
      throw err;
    }
  });
}
