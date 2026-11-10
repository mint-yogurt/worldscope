// What's urgent right now, across layers. Each check reads what its source already has,
// except squawks, which ask adsb.lol once a minute while someone is looking.
//   Item: { id, kind, level, title, sub, lon, lat, at, open: { type, id, zoom } }
//   level is "critical" or "warning". Critical items come first.

import { cached } from '../lib/cache.js';
import * as events from './events/index.js';
import * as flights from './flights.js';
import * as outages from './outages.js';
import * as radiation from './radiation.js';
import * as ships from './ships.js';

const TTL_MS = 60_000;
const WAIT_MS = 12_000; // a slow source misses this round rather than holding the rest up
const EVENT_HOURS = 24;
const MAJOR_QUAKE = 6.5;
const VERY_HIGH_USV = 1; // the Radiation layer's "Very high" band starts here
// Volunteer sensors fail in ways that look like this, and a few read high for weeks, so
// they need the layer's top band before they count.
const VOLUNTEER_USV = 10;
const STATION_MAX_AGE_MS = 6 * 3600_000;
const SHIP_MAX_AGE_MS = 30 * 60_000;

const SQUAWK_TEXT = {
  7700: ['General emergency', 'critical'],
  7600: ['Lost radio contact', 'warning'],
  7500: ['Hijack code', 'critical'],
};
const SART_SUB = { 970: 'AIS-SART distress beacon', 972: 'Man overboard beacon', 974: 'EPIRB distress beacon' };
const FROM_HAZARD_FEEDS = ['usgs', 'gdacs'];

async function squawks() {
  return (await flights.squawking()).map((a) => {
    const [meaning, level] = SQUAWK_TEXT[a.squawk] || ['Emergency', 'critical'];
    return {
      id: `flight:${a.hex}`, kind: 'flight', level,
      title: `${a.flight || a.reg || a.hex.toUpperCase()} squawking ${a.squawk}`,
      sub: `${meaning}${a.alt != null ? ` · ${a.alt.toLocaleString()} ft` : ''}`,
      lon: a.lon, lat: a.lat, at: Date.now() - a.age * 1000,
      open: { type: 'flight', id: a.hex, zoom: 7 },
    };
  });
}

function distressShips() {
  const now = Date.now();
  const out = [];
  for (const s of ships.tracked()) {
    const prefix = Math.floor(s.mmsi / 1e6);
    if (s.nav !== 14 && !SART_SUB[prefix]) continue;
    if (now - s.at > SHIP_MAX_AGE_MS) continue;
    out.push({
      id: `ship:${s.mmsi}`, kind: 'ship', level: 'critical',
      title: s.name || `Beacon ${s.mmsi}`,
      sub: SART_SUB[prefix] || 'AIS distress signal',
      lon: s.lon, lat: s.lat, at: s.at,
      open: { type: 'ship', id: String(s.mmsi), zoom: 9 },
    });
  }
  return out;
}

async function highRadiation() {
  const { stations } = await radiation.list();
  const now = Date.now();
  return stations
    .filter((s) => s.value >= (s.src === 'safecast' ? VOLUNTEER_USV : VERY_HIGH_USV) && now - s.at < STATION_MAX_AGE_MS)
    .map((s) => {
      const volunteer = s.src === 'safecast';
      return {
        id: `radiation:${s.id}`, kind: 'radiation', level: volunteer ? 'warning' : 'critical',
        title: `${s.value.toFixed(2)} µSv/h at ${s.name}`,
        sub: volunteer ? 'Volunteer sensor, unconfirmed' : 'Official station',
        lon: s.lon, lat: s.lat, at: s.at,
        open: { type: 'radiation', id: s.id, zoom: 9 },
      };
    });
}

function majorEvents() {
  return events.list(new URL(`http://local/?hours=${EVENT_HOURS}`)).events
    .filter((e) => FROM_HAZARD_FEEDS.includes(e.source))
    .filter((e) => {
      const magnitude = Number(e.title.match(/^M ([\d.]+)/)?.[1]); // USGS titles, "M 6.7 earthquake"
      return magnitude ? magnitude >= MAJOR_QUAKE : e.severity >= 3;
    })
    .map((e) => ({
      id: `event:${e.id}`, kind: 'event', level: 'critical',
      title: e.title, sub: e.place || '',
      lon: e.lon, lat: e.lat, at: e.start,
      open: { type: 'event', id: e.id, zoom: 5 },
    }));
}

async function internetDown() {
  return (await outages.list()).outages
    .filter((o) => o.ongoing)
    .map((o) => ({
      id: `outage:${o.id}`, kind: 'outage', level: 'warning',
      title: `Internet outage in ${o.name}`,
      sub: o.signals.join(', '),
      lon: o.lon, lat: o.lat, at: o.start,
      open: { type: 'outage', id: o.id, zoom: 4 },
    }));
}

const CHECKS = [
  ['Flights', squawks],
  ['Ships', distressShips],
  ['Radiation', highRadiation],
  ['Disasters', majorEvents],
  ['Internet outages', internetDown],
];

const inTime = (fn) => Promise.race([
  Promise.resolve().then(fn),
  new Promise((_, reject) => setTimeout(() => reject(new Error('took too long')), WAIT_MS).unref()),
]);

// GET /api/emergencies -> { time, unavailable: [names], items }
export function list() {
  return cached('emergencies', TTL_MS, async () => {
    const results = await Promise.allSettled(CHECKS.map(([, check]) => inTime(check)));
    const items = [];
    const unavailable = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') items.push(...r.value);
      else {
        unavailable.push(CHECKS[i][0]);
        console.warn(`[emergencies] ${CHECKS[i][0]}: ${r.reason.message}`);
      }
    });
    const rank = (item) => (item.level === 'critical' ? 0 : 1);
    items.sort((a, b) => rank(a) - rank(b) || b.at - a.at);
    return { time: Date.now(), unavailable, items };
  });
}
