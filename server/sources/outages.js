// Internet outages: countries that IODA (Georgia Tech) flagged in the last two days.
// Google traffic alerts are left out. On their own they run for days with nothing wrong
// (Finland showed a five-day "outage" when this was built), so a country needs a drop
// in routing, probing or telescope traffic to count.

import { cached } from '../lib/cache.js';
import { fetchJson, HttpError } from '../lib/http.js';
import * as countries from './countries.js';

const IODA = 'https://api.ioda.inetintel.cc.gatech.edu/v2';
const HOURS = 48;
const TTL_MS = 10 * 60_000;
const ONGOING_MS = 30 * 60_000; // IODA's data runs a little behind the clock
const MIN_SECONDS = 30 * 60; // shorter blips are usually measurement noise
// Longer than this, the normal level has moved, as when a network renumbers. Kuwait
// showed a 14-day "outage" when this was built.
const MAX_SECONDS = 7 * 86_400;
const MAX_POINTS = 96;
const SIGNALS = {
  bgp: 'Routing (BGP)',
  'ping-slash24': 'Active probing',
  'merit-nt': 'Network telescope',
};

// Middle of the country's biggest landmass, by outline area.
const centers = new Map();
function centerOf(c) {
  if (centers.has(c.id)) return centers.get(c.id);
  let best = null;
  let bestArea = 0;
  for (const [ring] of c.polygons) {
    let area = 0;
    let x = 0;
    let y = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      area += cross;
      x += (ring[j][0] + ring[i][0]) * cross;
      y += (ring[j][1] + ring[i][1]) * cross;
    }
    if (area && Math.abs(area) >= bestArea) {
      bestArea = Math.abs(area);
      best = [x / (3 * area), y / (3 * area)];
    }
  }
  centers.set(c.id, best);
  return best;
}

// GET /api/outages -> one row per country, ongoing first.
export function list() {
  return cached('outages', TTL_MS, async () => {
    const until = Math.floor(Date.now() / 1000);
    const q = new URLSearchParams({
      entityType: 'country', from: until - HOURS * 3600, until, includeAlerts: 'false', format: 'codf', limit: 1000,
    });
    const d = await fetchJson(`${IODA}/outages/events?${q}`, { timeout: 30_000 });
    const table = countries.all();
    const byCountry = new Map();
    for (const e of d.data) {
      const id = e.location?.split('/')[1];
      if (!SIGNALS[e.datasource] || !table.has(id)) continue;
      const end = e.start + e.duration;
      const ongoing = until - end < ONGOING_MS / 1000;
      if (e.duration > MAX_SECONDS || (!ongoing && e.duration < MIN_SECONDS)) continue;
      const row = byCountry.get(id) ?? byCountry.set(id, { start: e.start, end, ongoing: false, signals: new Set(), score: 0 }).get(id);
      row.start = Math.min(row.start, e.start);
      row.end = Math.max(row.end, end);
      row.ongoing ||= ongoing;
      row.score = Math.max(row.score, e.score);
      row.signals.add(SIGNALS[e.datasource]);
    }
    const rows = [];
    for (const [id, row] of byCountry) {
      const c = table.get(id);
      const center = centerOf(c);
      if (!center) continue;
      rows.push({
        id, name: c.name, lon: center[0], lat: center[1], ongoing: row.ongoing,
        start: row.start * 1000, end: row.end * 1000, score: Math.round(row.score), signals: [...row.signals],
      });
    }
    rows.sort((a, b) => b.ongoing - a.ongoing || b.end - a.end);
    return { time: until * 1000, hours: HOURS, outages: rows };
  });
}

const average = (values) => {
  const known = values.filter(Number.isFinite);
  return known.length ? known.reduce((sum, v) => sum + v, 0) / known.length : null;
};

// Long series are averaged down to what a small chart can show.
function shrink(values) {
  const group = Math.ceil(values.length / MAX_POINTS);
  const out = [];
  for (let i = 0; i < values.length; i += group) out.push(average(values.slice(i, i + group)));
  return out;
}

// GET /api/outages/:country -> its row plus how each signal moved over the two days.
export async function details(id) {
  id = id.toUpperCase();
  if (!/^[A-Z0-9-]{2,6}$/.test(id)) throw new HttpError(400, 'bad country');
  const row = (await list()).outages.find((o) => o.id === id);
  if (!row) throw new HttpError(400, 'No recent outage in this country');
  const series = await cached(`outages:${id}`, TTL_MS, async () => {
    const until = Math.floor(Date.now() / 1000);
    const d = await fetchJson(`${IODA}/signals/raw/country/${id}?from=${until - HOURS * 3600}&until=${until}`, { timeout: 30_000 });
    return (d.data[0] || [])
      .filter((s) => SIGNALS[s.datasource])
      .map((s) => ({ name: SIGNALS[s.datasource], from: s.from * 1000, until: s.until * 1000, values: shrink(s.values) }));
  });
  return { ...row, series };
}

// A row for a country's panel, if it had an outage.
export async function forCountry(id) {
  return (await list()).outages.find((o) => o.id === id) || null;
}
