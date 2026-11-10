// World events: ingesters poll each source on its own schedule and upsert into
// the store; the API reads from the store only, so browsers never wait on the
// sources. Adding a source = a module exporting { id, name, everyMs, fetch }.

import { HttpError } from '../../lib/http.js';
import * as store from './store.js';
import { usgs } from './usgs.js';
import { gdacs, geometry } from './gdacs.js';
import { eonet } from './eonet.js';
import { wikipedia } from './wikipedia.js';
import { related as gdeltRelated } from './gdelt.js';

// Hazard feeds first: the news ingester skips items they already cover.
const SOURCES = [usgs, gdacs, eonet, wikipedia];
const status = {}; // id -> { name, ok, error, at, count }

async function ingest(source) {
  try {
    const events = await source.fetch({ first: store.countFrom(source.id) === 0 });
    store.upsert(events);
    status[source.id] = { name: source.name, ok: true, at: Date.now(), count: events.length };
  } catch (err) {
    status[source.id] = { ...status[source.id], name: source.name, ok: false, error: err.message, at: Date.now() };
    console.warn(`[events] ${source.name}: ${err.message} (retrying in 2 min)`);
    if (!source.retrying) {
      source.retrying = true;
      setTimeout(() => { source.retrying = false; ingest(source); }, 2 * 60_000).unref();
    }
  }
}

export function start() {
  const removed = store.prune();
  if (removed) console.log(`[events] pruned ${removed} old events`);
  setInterval(() => store.prune(), 6 * 3600_000).unref();
  // Stagger the first runs a little so startup isn't one burst of requests.
  SOURCES.forEach((source, i) => {
    setTimeout(() => ingest(source), 1000 + i * 2000).unref();
    setInterval(() => ingest(source), source.everyMs).unref();
  });
}

// GET /api/events?hours=168 -> everything active within the last `hours`.
export function list(url) {
  const maxHours = store.retentionDays() * 24;
  const hours = Number(url.searchParams.get('hours') || 168);
  if (!(hours > 0)) throw new HttpError(400, 'hours must be a positive number');
  return {
    retentionDays: store.retentionDays(),
    sources: Object.values(status),
    events: store.listSince(Date.now() - Math.min(hours, maxHours) * 3600_000),
  };
}

// GET /api/events/:id -> full details, plus shapes to draw when the source has them.
export async function get(id) {
  const event = store.get(id);
  if (!event) throw new HttpError(400, 'Unknown event (it may have expired)');
  let shape = null;
  if (event.data.geometry) {
    try {
      shape = await geometry(event.data.geometry);
    } catch (err) {
      console.warn(`[events] shape for ${id}: ${err.message}`);
    }
  }
  return { ...event, shape };
}

// GET /api/events/:id/related -> news articles about it (GDELT, best-effort).
export async function related(id) {
  const event = store.get(id);
  if (!event) throw new HttpError(400, 'Unknown event (it may have expired)');
  // Best-effort extra: a GDELT refusal is an empty list, not an error.
  return gdeltRelated(event).catch((err) => {
    console.warn(`[events] related coverage for ${id}: ${err.message}`);
    return { query: null, articles: [], error: err.message };
  });
}
