import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tiny in-memory cache with in-flight de-duplication: many browser polls for
// the same key share one upstream request. On upstream failure we keep
// serving the last good value if there is one.

const store = new Map(); // key -> { value, expires, pending }

export function cached(key, ttlMs, load) {
  const hit = store.get(key);
  if (hit && hit.value !== undefined && hit.expires > Date.now()) return Promise.resolve(hit.value);
  if (hit?.pending) return hit.pending;

  const pending = load().then(
    (value) => {
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    },
    (err) => {
      if (hit && hit.value !== undefined) {
        store.set(key, { value: hit.value, expires: Date.now() + Math.min(ttlMs, 30_000) });
        console.warn(`[cache] ${key}: ${err.message} (serving stale)`);
        return hit.value;
      }
      store.delete(key);
      throw err;
    },
  );
  store.set(key, { ...hit, pending });
  return pending;
}

// Like `cached`, but also persisted to data/cache/<key>.json so server restarts
// don't re-download. For sources that limit how often you may fetch (CelesTrak).
// If the upstream fails, any copy on disk is served, however old.
const CACHE_DIR = fileURLToPath(new URL('../../data/cache/', import.meta.url));

export function cachedOnDisk(key, ttlMs, load) {
  const file = join(CACHE_DIR, `${key}.json`);
  return cached(`disk:${key}`, ttlMs, async () => {
    let saved = null;
    try {
      saved = JSON.parse(await readFile(file, 'utf8'));
    } catch { /* nothing saved yet */ }
    if (saved && Date.now() - saved.savedAt < ttlMs) return saved.value;
    try {
      const value = await load();
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(file, JSON.stringify({ savedAt: Date.now(), value }));
      return value;
    } catch (err) {
      if (!saved) throw err;
      console.warn(`[cache] ${key}: ${err.message} (serving copy from ${new Date(saved.savedAt).toISOString()})`);
      return saved.value;
    }
  });
}

// Drop entries that expired a while ago so the map doesn't grow forever.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [key, entry] of store) {
    if (!entry.pending && entry.expires < cutoff) store.delete(key);
  }
}, 10 * 60_000).unref();

// Serializes calls so an upstream API sees at most one request per `gapMs`.
export function throttle(gapMs) {
  let next = 0;
  return async (fn) => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + gapMs;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    return fn();
  };
}
