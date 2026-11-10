// Event store: one SQLite file (data/events.sqlite) using Node's built-in
// node:sqlite, so still no npm dependencies. This is a rolling window of what's
// happening now, not an archive: anything that ended more than
// EVENTS_RETENTION_DAYS ago (default 30) is deleted, so the file stays small.

import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const DATA_DIR = fileURLToPath(new URL('../../../data/', import.meta.url));
const DB_FILE = `${DATA_DIR}events.sqlite`;
const DAY_MS = 86_400_000;

export const retentionDays = () => Math.max(1, Number(process.env.EVENTS_RETENTION_DAYS) || 30);

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA auto_vacuum = INCREMENTAL;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS events (
    id         TEXT PRIMARY KEY,  -- "<source>:<source id>"
    source     TEXT NOT NULL,
    kind       TEXT NOT NULL,     -- quake, cyclone, flood, volcano, drought, wildfire, ...
    severity   INTEGER NOT NULL,  -- 1 minor, 2 significant, 3 major
    title      TEXT NOT NULL,
    place      TEXT,
    lat        REAL NOT NULL,
    lon        REAL NOT NULL,
    start_time INTEGER NOT NULL,  -- ms since epoch
    end_time   INTEGER,           -- null while ongoing
    last_seen  INTEGER NOT NULL,  -- last time a source still listed it
    url        TEXT,
    summary    TEXT,
    data       TEXT               -- JSON: source-specific details shown in the panel
  );
  -- An event is "active until" its end, or until a source last listed it if ongoing.
  CREATE INDEX IF NOT EXISTS events_active ON events (max(start_time, coalesce(end_time, last_seen)));
`);

const upsertStmt = db.prepare(`
  INSERT INTO events (id, source, kind, severity, title, place, lat, lon, start_time, end_time, last_seen, url, summary, data)
  VALUES (:id, :source, :kind, :severity, :title, :place, :lat, :lon, :start, :end, :seen, :url, :summary, :data)
  ON CONFLICT (id) DO UPDATE SET
    kind = excluded.kind, severity = excluded.severity, title = excluded.title, place = excluded.place,
    lat = excluded.lat, lon = excluded.lon, start_time = excluded.start_time, end_time = excluded.end_time,
    last_seen = excluded.last_seen, url = excluded.url, summary = excluded.summary, data = excluded.data
`);

export function upsert(events) {
  const seen = Date.now();
  db.exec('BEGIN');
  try {
    for (const e of events) {
      upsertStmt.run({
        id: e.id, source: e.source, kind: e.kind, severity: e.severity, title: e.title, place: e.place ?? null,
        lat: e.lat, lon: e.lon, start: e.start, end: e.end ?? null, seen, url: e.url ?? null,
        summary: e.summary ?? null, data: JSON.stringify(e.data ?? {}),
      });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const countStmt = db.prepare('SELECT count(*) AS n FROM events WHERE source = ?');
export const countFrom = (source) => countStmt.get(source).n;

// Everything active at some point since `sinceMs`, without the bulky details.
const listStmt = db.prepare(`
  SELECT id, source, kind, severity, title, place, lat, lon, start_time AS start, end_time AS end, last_seen AS seen
  FROM events
  WHERE max(start_time, coalesce(end_time, last_seen)) >= ?
  ORDER BY severity, start_time
`);
export const listSince = (sinceMs) => listStmt.all(sinceMs);

const getStmt = db.prepare(`
  SELECT id, source, kind, severity, title, place, lat, lon, start_time AS start, end_time AS end,
         last_seen AS seen, url, summary, data
  FROM events WHERE id = ?
`);
export function get(id) {
  const row = getStmt.get(id);
  return row && { ...row, data: JSON.parse(row.data || '{}') };
}

// Events active since `sinceMs` within roughly `km` of a point (bounding box, then exact distance).
const nearbyStmt = db.prepare(`
  SELECT id, source, kind, lat, lon FROM events
  WHERE lat BETWEEN ? AND ? AND max(start_time, coalesce(end_time, last_seen)) >= ?
`);
export function nearby(lat, lon, km, sinceMs) {
  const dLat = km / 111;
  const rad = Math.PI / 180;
  return nearbyStmt.all(lat - dLat, lat + dLat, sinceMs).filter((e) => {
    const a = Math.sin(((e.lat - lat) * rad) / 2) ** 2
      + Math.cos(lat * rad) * Math.cos(e.lat * rad) * Math.sin(((e.lon - lon) * rad) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(a)) <= km;
  });
}

const pruneStmt = db.prepare('DELETE FROM events WHERE max(start_time, coalesce(end_time, last_seen)) < ?');
export function prune() {
  const { changes } = pruneStmt.run(Date.now() - retentionDays() * DAY_MS);
  if (changes) db.exec('PRAGMA incremental_vacuum');
  return changes;
}
