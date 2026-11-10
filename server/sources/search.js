// Search across places and everything live on the map.
// Countries and cities are local files, live objects come from the other sources'
// in-memory data, and Photon (OpenStreetMap) adds the places our cities list lacks.
// Nominatim isn't used: its policy forbids search-as-you-type.

import { readFileSync } from 'node:fs';
import { cached, throttle } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import * as countries from './countries.js';
import * as events from './events/index.js';
import * as flights from './flights.js';
import * as launches from './launches.js';
import * as radiation from './radiation.js';
import * as radio from './radio.js';
import * as ships from './ships.js';
import * as space from './space.js';
import * as webcams from './webcams.js';

const PHOTON = 'https://photon.komoot.io/api/';
const PER_GROUP = 5;
// A source that isn't ready just misses this search; it keeps loading for the next one.
const QUICK_MS = 300;
const REMOTE_MS = 1500;
const photonGate = throttle(700);

// Lower case, no accents, punctuation as spaces: "ISS (ZARYA)" matches "iss zarya".
const norm = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().trim();

// 4 exact, 3 starts with it, 2 a word starts with it, 1 contains it, 0 no match.
function rank(text, q) {
  if (!text) return 0;
  const t = norm(text);
  if (t === q) return 4;
  if (t.startsWith(q)) return 3;
  const i = t.indexOf(q);
  if (i < 0) return 0;
  return t[i - 1] === ' ' ? 2 : 1;
}

// Best matches first; `weight` breaks ties (bigger first).
function best(items, score, weight = () => 0) {
  const hits = [];
  for (const item of items) {
    const s = score(item);
    if (s > 0) hits.push({ item, s, w: weight(item) });
  }
  return hits.sort((a, b) => b.s - a.s || b.w - a.w).slice(0, PER_GROUP).map((h) => h.item);
}

const soon = (promise, ms) => Promise.race([
  Promise.resolve(promise).catch(() => null),
  new Promise((resolve) => setTimeout(resolve, ms, null).unref()),
]);

// --- Places ------------------------------------------------------------------------

let cityTable = null;
function cities() {
  cityTable ??= JSON.parse(readFileSync(new URL('../geo/cities.json', import.meta.url), 'utf8'))
    .map(([name, ascii, lon, lat, iso, pop]) => ({ name, ascii, lon, lat, iso, pop }));
  return cityTable;
}

function countryResults(q) {
  return best(countries.all().values(), (c) => Math.max(rank(c.name, q), rank(c.long, q), c.iso?.toLowerCase() === q ? 4 : 0), (c) => c.pop)
    .map((c) => ({ type: 'country', id: c.id, label: c.name, sub: c.region }));
}

function cityResults(q) {
  const names = countries.all();
  return best(cities(), (c) => Math.max(rank(c.name, q), rank(c.ascii, q)), (c) => c.pop).map((c) => ({
    type: 'place', label: c.name, sub: names.get(c.iso)?.name || c.iso, lon: c.lon, lat: c.lat, zoom: c.pop > 1e6 ? 9 : 11,
  }));
}

const PLACE_ZOOM = { country: 4, state: 6, region: 6, county: 8, city: 10, town: 11, village: 12 };

function photon(q) {
  return cached(`photon:${q}`, 3600_000, async () => {
    const url = `${PHOTON}?${new URLSearchParams({ q, limit: '6', lang: 'en' })}`;
    const d = await photonGate(() => fetchJson(url, { timeout: 8000 }));
    // Countries have their own group.
    return d.features.filter((f) => f.properties.name && f.properties.type !== 'country').map((f) => {
      const p = f.properties;
      const [lon, lat] = f.geometry.coordinates;
      return {
        type: 'place', label: p.name,
        sub: [p.city !== p.name && p.city, p.state, p.country].filter(Boolean).join(', '),
        lon, lat, zoom: PLACE_ZOOM[p.type] ?? PLACE_ZOOM[p.osm_value] ?? 14,
      };
    });
  });
}

async function placeResults(q) {
  const local = cityResults(q);
  // Plenty of towns already: no need to trouble Photon.
  if (local.length >= PER_GROUP || q.length < 3) return local;
  const more = (await soon(photon(q), REMOTE_MS)) || [];
  const fresh = more.filter((p) => !local.some((c) => Math.abs(c.lon - p.lon) + Math.abs(c.lat - p.lat) < 0.3));
  return [...local, ...fresh].slice(0, PER_GROUP);
}

// --- Things on the map -------------------------------------------------------------

function shipResults(q) {
  const digits = /^\d{5,}$/.test(q) ? q : null;
  const found = best(ships.tracked(), (s) => {
    if (digits && (String(s.mmsi) === digits || String(s.imo) === digits)) return 4;
    return Math.max(rank(s.name, q), s.callsign?.toLowerCase() === q ? 4 : 0);
  }, (s) => s.at);
  return found.map((s) => ({
    type: 'ship', id: s.mmsi, label: s.name || `MMSI ${s.mmsi}`,
    sub: [s.typeName || 'Ship', Number.isFinite(s.sog) && s.sog >= 0.5 ? `${s.sog.toFixed(0)} kn` : 'stopped'].join(' · '),
    lon: s.lon, lat: s.lat, zoom: 10,
  }));
}

function eventResults(q) {
  const list = events.list(new URL('http://local/?hours=100000')).events;
  return best(list, (e) => Math.max(rank(e.title, q), rank(e.place, q)), (e) => e.severity * 1e13 + e.start)
    .map((e) => ({ type: 'event', id: e.id, label: e.title, sub: e.place || '', lon: e.lon, lat: e.lat, zoom: 6 }));
}

async function flightResults(q) {
  // Only things shaped like a callsign, so typing a place name never calls OpenSky.
  if (!/^[a-z]{2,3}\d[a-z0-9]{0,4}$|^[0-9a-f]{6}$/.test(q)) return [];
  const world = await soon(flights.world(), REMOTE_MS);
  if (!world) return [];
  return best(world.aircraft, (a) => (a.hex === q ? 4 : rank(a.flight, q))).map((a) => ({
    type: 'flight', id: a.hex, label: a.flight?.trim() || a.hex.toUpperCase(),
    sub: a.ground ? 'on the ground' : `${(a.alt ?? 0).toLocaleString()} ft`, lon: a.lon, lat: a.lat, zoom: 7,
  }));
}

async function satelliteResults(q) {
  const data = await soon(space.satellites(), QUICK_MS);
  if (!data) return [];
  const digits = /^\d+$/.test(q) ? Number(q) : null;
  return best(data.satellites, (s) => (s.NORAD_CAT_ID === digits ? 4 : rank(s.OBJECT_NAME, q)), (s) => -s.OBJECT_NAME.length)
    .map((s) => ({ type: 'satellite', id: s.NORAD_CAT_ID, label: s.OBJECT_NAME, sub: `Satellite · ${s.category}` }));
}

async function radiationResults(q) {
  const data = await soon(radiation.list(), QUICK_MS);
  if (!data) return [];
  return best(data.stations, (s) => rank(s.name, q)).map((s) => ({
    type: 'radiation', id: s.id, label: s.name, sub: `${s.value.toFixed(2)} µSv/h`, lon: s.lon, lat: s.lat, zoom: 9,
  }));
}

async function webcamResults(q) {
  const cams = await soon(webcams.known(), QUICK_MS);
  if (!cams) return [];
  return best(cams, (c) => rank(c.name, q)).map((c) => ({
    type: 'webcam', id: c.id, label: c.name, sub: { windy: 'Webcam', fi: 'Road camera, Finland', ca: 'Road camera, California' }[c.src],
    lon: c.lon, lat: c.lat, zoom: 11,
  }));
}

async function stationResults(q) {
  const list = await soon(radio.allStations(), QUICK_MS);
  if (!list) return [];
  return best(list, (s) => rank(s.name, q), (s) => s.clicks).map((s) => ({
    type: 'radio', id: s.id, label: s.name, sub: ['Internet radio', s.country].filter(Boolean).join(' · '), lon: s.lon, lat: s.lat, zoom: 8,
  }));
}

async function receiverResults(q) {
  const data = await soon(radio.receivers(), QUICK_MS);
  if (!data) return [];
  return best(data.sites, (s) => Math.max(rank(s.name, q), ...s.receivers.map((r) => rank(r.name, q)))).map((s) => ({
    type: 'radio', id: s.id, label: s.name, sub: `${s.receivers[0].type} receiver`, lon: s.lon, lat: s.lat, zoom: 8,
  }));
}

async function launchResults(q) {
  const data = await soon(launches.list(), QUICK_MS);
  if (!data) return [];
  return best(data.launches, (l) => Math.max(rank(l.name, q), rank(l.full, q), rank(l.rocket, q)), (l) => l.net)
    .map((l) => ({
      type: 'launch', id: l.id, label: l.name, sub: [l.rocket, new Date(l.net).toISOString().slice(0, 10)].filter(Boolean).join(' · '),
      lon: l.lon, lat: l.lat, zoom: 8,
    }));
}

// GET /api/search?q= -> { groups: [{ id, label, items }] }
export async function search(url) {
  const q = norm(url.searchParams.get('q') || '').slice(0, 60);
  if (q.length < 2) return { query: q, groups: [] };
  const [places, flightHits, satHits, radHits, camHits, stationHits, receiverHits, launchHits] = await Promise.all([
    placeResults(q), flightResults(q), satelliteResults(q), radiationResults(q),
    webcamResults(q), stationResults(q), receiverResults(q), launchResults(q),
  ]);
  const groups = [
    { id: 'countries', label: 'Countries', items: countryResults(q) },
    { id: 'places', label: 'Places', items: places },
    { id: 'events', label: 'Events', items: eventResults(q) },
    { id: 'ships', label: 'Ships', items: shipResults(q) },
    { id: 'flights', label: 'Flights', items: flightHits },
    { id: 'satellites', label: 'Satellites', items: satHits },
    { id: 'launches', label: 'Launches', items: launchHits },
    { id: 'radiation', label: 'Radiation stations', items: radHits },
    { id: 'webcams', label: 'Webcams', items: camHits },
    { id: 'stations', label: 'Radio stations', items: stationHits },
    { id: 'receivers', label: 'SDR receivers', items: receiverHits },
  ];
  // Groups with the closest match come first, so Enter opens the best result.
  const closeness = (g) => Math.max(...g.items.map((item) => rank(item.label, q)));
  return {
    query: q,
    groups: groups.filter((g) => g.items.length).sort((a, b) => closeness(b) - closeness(a)),
  };
}
