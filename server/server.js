// WorldScope local server.
// Serves the static frontend from /public and (later) proxies + caches the
// external data APIs under /api/*. No npm dependencies on purpose.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as flights from './sources/flights.js';
import * as weather from './sources/weather.js';
import * as space from './sources/space.js';
import * as events from './sources/events/index.js';
import * as ships from './sources/ships.js';
import * as radiation from './sources/radiation.js';
import * as radio from './sources/radio.js';
import * as webcams from './sources/webcams.js';
import * as outages from './sources/outages.js';
import * as launches from './sources/launches.js';
import * as emergencies from './sources/emergencies.js';
import * as tour from './sources/tour.js';
import * as countries from './sources/countries.js';
import * as search from './sources/search.js';

// All API keys live in one file, secrets/secrets.env (template: secrets/secrets.example.env).
// It's optional; real environment variables win over it.
try {
  process.loadEnvFile(fileURLToPath(new URL('../secrets/secrets.env', import.meta.url)));
  console.log('Loaded secrets/secrets.env');
} catch {
  console.log('No secrets/secrets.env found; running without API keys');
}

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.woff2': 'font/woff2',
};

// API routes: [pattern, handler(url, ...captures)]. Each data source adds its routes here.
const api = [
  [/^\/api\/health$/, () => ({ ok: true, time: new Date().toISOString() })],
  [/^\/api\/presence$/, () => ships.viewer()],
  [/^\/api\/flights\/live$/, (url) => flights.live(url)],
  [/^\/api\/flights\/world$/, () => flights.world()],
  [/^\/api\/flights\/trace\/([^/]+)$/, (url, hex) => flights.trace(hex)],
  [/^\/api\/flights\/route\/([^/]+)$/, (url, callsign) => flights.route(callsign)],
  [/^\/api\/flights\/aircraft\/([^/]+)$/, (url, hex) => flights.details(hex)],
  [/^\/api\/weather\/wind$/, (url) => weather.wind(url)],
  [/^\/api\/weather\/forecast$/, (url) => weather.forecast(url)],
  [/^\/api\/space\/satellites$/, () => space.satellites()],
  [/^\/api\/space\/aurora$/, () => space.aurora()],
  [/^\/api\/space\/summary$/, () => space.summary()],
  [/^\/api\/events$/, (url) => events.list(url)],
  [/^\/api\/events\/([^/]+)$/, (url, id) => events.get(id)],
  [/^\/api\/events\/([^/]+)\/related$/, (url, id) => events.related(id)],
  [/^\/api\/ships$/, (url) => ships.list(url)],
  [/^\/api\/ships\/(\d+)$/, (url, mmsi) => ships.details(mmsi)],
  [/^\/api\/radiation$/, () => radiation.list()],
  [/^\/api\/radiation\/([^/]+)\/history$/, (url, id) => radiation.history(id)],
  [/^\/api\/radio\/receivers$/, () => radio.receivers()],
  [/^\/api\/radio\/stations$/, () => radio.stations()],
  [/^\/api\/radio\/stations\/([^/]+)$/, (url, id) => radio.station(id)],
  [/^\/api\/radio\/wspr$/, () => radio.wspr()],
  [/^\/api\/webcams$/, (url) => webcams.list(url)],
  [/^\/api\/webcams\/([^/]+)$/, (url, id) => webcams.details(id)],
  [/^\/api\/outages$/, () => outages.list()],
  [/^\/api\/outages\/([^/]+)$/, (url, id) => outages.details(id)],
  [/^\/api\/launches$/, () => launches.list()],
  [/^\/api\/launches\/([^/]+)$/, (url, id) => launches.details(id)],
  [/^\/api\/emergencies$/, () => emergencies.list()],
  [/^\/api\/tour$/, () => tour.stops()],
  [/^\/api\/search$/, (url) => search.search(url)],
  [/^\/api\/countries\/([^/]+)$/, (url, id) => countries.details(id)],
];

function sendJson(req, res, status, body) {
  let data = Buffer.from(JSON.stringify(body));
  const headers = { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' };
  if (data.length > 8192 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    data = gzipSync(data);
    headers['Content-Encoding'] = 'gzip';
  }
  res.writeHead(status, headers);
  res.end(data);
}

async function handleApi(req, res, url) {
  for (const [pattern, handler] of api) {
    const m = url.pathname.match(pattern);
    if (!m) continue;
    try {
      return sendJson(req, res, 200, await handler(url, ...m.slice(1).map(decodeURIComponent)));
    } catch (err) {
      // Our own input validation throws 400; anything else is an upstream failure.
      const status = err.status === 400 ? 400 : 502;
      console.warn(`[api] ${url.pathname}: ${err.message}`);
      return sendJson(req, res, status, { error: err.message, retryAfter: err.retryAfter });
    }
  }
  sendJson(req, res, 404, { error: 'Unknown API route' });
}

// Image tiles passed through from sources the browser can't load directly.
const TILES = [
  [/^\/tiles\/safecast\/(\d+)\/(\d+)\/(\d+)\.png$/, (z, x, y) => radiation.safecastTile(z, x, y)],
];

async function handleTile(res, url) {
  for (const [pattern, handler] of TILES) {
    const m = url.pathname.match(pattern);
    if (!m) continue;
    try {
      const body = await handler(...m.slice(1));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(body);
    } catch (err) {
      console.warn(`[tiles] ${url.pathname}: ${err.message}`);
      return res.writeHead(err.status === 400 ? 400 : 502).end();
    }
  }
  res.writeHead(404).end();
}

// Compressed copies of static JSON, by path + modified time.
const gzipped = new Map();
function gzipOnce(file, mtimeMs, body) {
  const hit = gzipped.get(file);
  if (hit?.mtimeMs === mtimeMs) return hit.data;
  const data = gzipSync(body);
  gzipped.set(file, { mtimeMs, data });
  return data;
}

async function serveStatic(pathname, req, res) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(PUBLIC_DIR, rel);
  // Block path traversal outside /public.
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    let body = await readFile(file);
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    const packed = type === MIME['.json'] && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (packed) body = gzipOnce(file, (await stat(file)).mtimeMs, body);
    res.writeHead(200, {
      'Content-Type': type,
      // Flags and country shapes rarely change; everything else revalidates.
      'Cache-Control': /^\/(flags|geo)\//.test(pathname) ? 'public, max-age=604800' : 'no-cache',
      ...(packed && { 'Content-Encoding': 'gzip' }),
      // Cross-origin isolation lets the weather layer share decoded data with its
      // workers (SharedArrayBuffer) instead of copying it per tile. "credentialless"
      // keeps third-party tiles, fonts and CDN scripts working without extra headers.
      // Worker scripts (JS) need the same policy or the isolated page refuses to start them.
      ...(/^text\/(html|javascript)/.test(type) && {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      }),
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/tiles/')) return await handleTile(res, url);
    await serveStatic(url.pathname, req, res);
  } catch (err) {
    console.error(err);
    sendJson(req, res, 500, { error: 'Internal error' });
  }
});

events.start();
ships.start();

server.listen(PORT, () => {
  console.log(`WorldScope running at http://localhost:${PORT}`);
});
