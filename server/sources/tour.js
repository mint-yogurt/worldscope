// Stops for tour mode: the most interesting things happening now, mixed so one kind
// doesn't take over the tour.
//   Stop: { type, id, lon, lat, zoom, kicker, title, sub }

import * as emergencies from './emergencies.js';
import * as events from './events/index.js';
import * as launches from './launches.js';
import * as outages from './outages.js';

const MAX_STOPS = 14;
const EVENT_HOURS = 72;
const EVENTS_PER_KIND = 2;
const MAX_EVENTS = 6;
const KICKERS = { flight: 'In the air', ship: 'At sea', radiation: 'Radiation', event: 'Emergency', outage: 'Internet' };
const SKIPPED_KINDS = ['politics', 'crime', 'news']; // better read than flown to
const SPACE_STATION = { type: 'satellite', id: '25544', kicker: 'In orbit', title: 'International Space Station', sub: 'Crewed, about 400 km up' };

const titled = (text) => text.charAt(0).toUpperCase() + text.slice(1);

async function emergencyStops() {
  const { items } = await emergencies.list();
  return items
    .filter((item) => item.level === 'critical')
    .map((item) => ({ ...item.open, lon: item.lon, lat: item.lat, kicker: KICKERS[item.kind], title: item.title, sub: item.sub }));
}

function eventStops() {
  const perKind = {};
  return events.list(new URL(`http://local/?hours=${EVENT_HOURS}`)).events
    .filter((e) => e.severity >= 2 && !SKIPPED_KINDS.includes(e.kind) && Number.isFinite(e.lon) && Number.isFinite(e.lat))
    .sort((a, b) => b.severity - a.severity || b.start - a.start)
    .filter((e) => (perKind[e.kind] = (perKind[e.kind] || 0) + 1) <= EVENTS_PER_KIND)
    .slice(0, MAX_EVENTS)
    .map((e) => ({
      type: 'event', id: e.id, lon: e.lon, lat: e.lat, zoom: 5,
      kicker: e.kind === 'quake' ? 'Earthquake' : titled(e.kind), title: e.title, sub: e.place || '',
    }));
}

async function launchStops() {
  const { launches: all } = await launches.list();
  const now = Date.now();
  const stop = (l, kicker) => ({
    type: 'launch', id: l.id, lon: l.lon, lat: l.lat, zoom: 6, kicker, title: l.name, sub: [l.rocket, l.site].filter(Boolean).join(' · '),
  });
  const next = all.find((l) => l.net > now);
  const last = all.findLast((l) => l.net <= now);
  return [next && stop(next, 'Next launch'), last && stop(last, 'Latest launch')].filter(Boolean);
}

async function outageStops() {
  return (await outages.list()).outages.slice(0, 2).map((o) => ({
    type: 'outage', id: o.id, lon: o.lon, lat: o.lat, zoom: 4,
    kicker: 'Internet', title: `${o.ongoing ? 'Outage' : 'Recent outage'} in ${o.name}`, sub: o.signals.join(', '),
  }));
}

// A source that's down just has no stops in this tour.
const orNothing = (fn) => Promise.resolve().then(fn).catch((err) => {
  console.warn(`[tour] ${err.message}`);
  return [];
});

// GET /api/tour -> { stops }. Emergencies lead, then one of each kind in turn.
export async function stops() {
  const lists = await Promise.all([emergencyStops, eventStops, launchStops, outageStops].map(orNothing));
  const [urgent, ...rest] = lists;
  const mixed = [...urgent];
  const seen = new Set(urgent.map((s) => `${s.type}:${s.id}`));
  for (let i = 0; rest.some((list) => list[i]); i++) {
    for (const list of rest) {
      const stop = list[i];
      if (!stop || seen.has(`${stop.type}:${stop.id}`)) continue;
      seen.add(`${stop.type}:${stop.id}`);
      mixed.push(stop);
    }
    if (i === 0) mixed.push(SPACE_STATION);
  }
  return { stops: (mixed.length ? mixed : [SPACE_STATION]).slice(0, MAX_STOPS) };
}
