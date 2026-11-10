// Countries: facts from the static file made by scripts/build-geo.mjs, a Wikipedia
// summary, and live counts worked out from what the other sources already hold.

import { readFileSync } from 'node:fs';
import { cached } from '../lib/cache.js';
import { fetchJson, HttpError } from '../lib/http.js';
import { userAgent } from './events/wikipedia.js';
import * as events from './events/index.js';
import * as flights from './flights.js';
import * as outages from './outages.js';
import * as radiation from './radiation.js';
import * as ships from './ships.js';

const WAIT_MS = 4000; // a slow source is left out of the counts rather than holding up the panel
const EVENT_HOURS = 168;

let table = null;

export function all() {
  if (table) return table;
  const list = JSON.parse(readFileSync(new URL('../../public/geo/countries.json', import.meta.url), 'utf8'));
  table = new Map(list.map((c) => [c.id, c]));
  return table;
}

function inRing(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inCountry(c, lon, lat) {
  return c.polygons.some(([outer, ...holes]) => inRing(outer, lon, lat) && !holes.some((h) => inRing(h, lon, lat)));
}

// Quarter-degree cells touching the country's outline, about 30-50 km either side of
// it. Good enough to say "near its coast" and quick to test against thousands of ships.
const cellOf = (lon, lat) => `${Math.floor(lon * 4)},${Math.floor(lat * 4)}`;
const coasts = new Map();
function coastCells(c) {
  let cells = coasts.get(c.id);
  if (cells) return cells;
  cells = new Set();
  for (const [outer] of c.polygons) {
    for (const [lon, lat] of outer) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) cells.add(cellOf(lon + dx / 4, lat + dy / 4));
    }
  }
  coasts.set(c.id, cells);
  return cells;
}

const soon = (promise) => Promise.race([
  Promise.resolve(promise).catch(() => null),
  new Promise((resolve) => setTimeout(resolve, WAIT_MS, null).unref()),
]);

function summary(c) {
  if (!c.wiki) return null;
  return cached(`country:wiki:${c.id}`, 24 * 3600_000, async () => {
    const title = encodeURIComponent(c.wiki.replaceAll(' ', '_'));
    const d = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`, {
      headers: { 'User-Agent': userAgent() },
    });
    return { extract: d.extract, url: d.content_urls?.desktop?.page };
  });
}

function live(c) {
  return cached(`country:live:${c.id}`, 60_000, async () => {
    const coast = coastCells(c);
    const nearby = (lon, lat) => coast.has(cellOf(lon, lat)) || inCountry(c, lon, lat);
    const found = events.list(new URL(`http://local/?hours=${EVENT_HOURS}`)).events
      .filter((e) => nearby(e.lon, e.lat))
      .sort((a, b) => b.severity - a.severity || b.start - a.start);

    let shipCount = 0;
    for (const s of ships.tracked()) if (coast.has(cellOf(s.lon, s.lat))) shipCount++;

    const [air, rad, outage] = await Promise.all([soon(flights.world()), soon(radiation.list()), soon(outages.forCountry(c.id))]);
    const stations = rad?.stations.filter((s) => inCountry(c, s.lon, s.lat)) || [];
    return {
      events: {
        count: found.length,
        top: found.slice(0, 5).map(({ id, title, kind, severity, start }) => ({ id, title, kind, severity, start })),
      },
      ships: shipCount,
      outage: outage && { ongoing: outage.ongoing, end: outage.end },
      flights: air ? air.aircraft.filter((a) => !a.ground && inCountry(c, a.lon, a.lat)).length : null,
      radiation: stations.length ? {
        stations: stations.length,
        average: Math.round((stations.reduce((n, s) => n + s.value, 0) / stations.length) * 1000) / 1000,
      } : null,
    };
  });
}

// GET /api/countries/:id -> summary text and live counts. Facts and shapes come from the static file.
export async function details(id) {
  const c = all().get(id);
  if (!c) throw new HttpError(400, 'Unknown country');
  const [wiki, now] = await Promise.all([soon(summary(c)), live(c)]);
  return { id, wiki, now };
}
