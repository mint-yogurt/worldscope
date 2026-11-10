// Rocket launches from Launch Library 2 (The Space Devs). The free tier allows about 15
// requests an hour, and a refresh takes two, so this is kept on disk and only refreshed
// when someone is looking.

import { cachedOnDisk } from '../lib/cache.js';
import { fetchJson, HttpError } from '../lib/http.js';

const LL2 = 'https://ll.thespacedevs.com/2.3.0';
const TTL_MS = 20 * 60_000;
const UPCOMING = 40;
const PREVIOUS = 20;
const RECENT_DAYS = 14;
// Finer than this, a launch time is good enough for a running countdown.
const EXACT_PRECISION = ['Second', 'Minute', 'Hour'];

function row(l) {
  const { pad, mission, rocket, status } = l;
  return {
    id: l.id,
    name: mission?.name && !/^unknown/i.test(mission.name) ? mission.name : l.name,
    full: l.name,
    rocket: rocket?.configuration?.full_name || rocket?.configuration?.name || null,
    provider: l.launch_service_provider?.name || null,
    status: status?.abbrev || 'TBD',
    statusText: status?.name || 'To be determined',
    failure: l.failreason || null,
    net: Date.parse(l.net),
    exact: EXACT_PRECISION.includes(l.net_precision?.name),
    precision: l.net_precision?.name || null,
    pad: pad?.name || null,
    site: pad?.location?.name || null,
    lon: pad?.longitude,
    lat: pad?.latitude,
    orbit: mission?.orbit?.name && mission.orbit.name !== 'Unknown' ? mission.orbit.name : null,
    about: mission?.description && mission.description !== 'Details TBD.' ? mission.description : null,
    live: !!l.webcast_live,
    watch: mission?.vid_urls?.[0]?.url || null,
    info: mission?.info_urls?.[0]?.url || pad?.wiki_url || null,
  };
}

// GET /api/launches -> recent and upcoming launches, soonest first.
export function list() {
  return cachedOnDisk('launches', TTL_MS, async () => {
    const [next, past] = await Promise.all([
      fetchJson(`${LL2}/launches/upcoming/?limit=${UPCOMING}&mode=normal`, { timeout: 30_000 }),
      fetchJson(`${LL2}/launches/previous/?limit=${PREVIOUS}&mode=normal`, { timeout: 30_000 }),
    ]);
    const since = Date.now() - RECENT_DAYS * 86_400_000;
    const launches = [...past.results, ...next.results]
      .map(row)
      .filter((l) => Number.isFinite(l.lon) && Number.isFinite(l.lat) && Number.isFinite(l.net) && l.net > since)
      .sort((a, b) => a.net - b.net);
    return { time: Date.now(), launches };
  });
}

// GET /api/launches/:id
export async function details(id) {
  const found = (await list()).launches.find((l) => l.id === id);
  if (!found) throw new HttpError(400, 'Launch is no longer listed');
  return found;
}
