// Live flights: 3D plane models, smooth motion between updates, and a
// selected-aircraft view with the path flown so far and the route ahead.
//
// Data (via our server, see server/sources/flights.js):
//   - live: adsb.lol / airplanes.live around the view center (<= 250 nm), every 5 s
//   - world: OpenSky global snapshot whenever the view is wider than that
// Live data wins wherever both cover the same area.

import { THEMES } from '../themes.js';
import { airplaneMesh } from '../models/airplane.js';
import * as geo from '../geo.js';
import { createFlightPanel, esc } from './flight-panel.js';

const LIVE_MAX_NM = 250;
const LIVE_EVERY_MS = 5000;
const WORLD_EVERY_MS = 30_000;
const DRAW_EVERY_MS = 50;
const KT_TO_MS = 0.514444;
const FT_TO_M = 0.3048;
const PLANE_LAYERS = ['flights:planes', 'flights:selected'];

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export function createFlights({ map, overlay, panelEl, onCount, onStatus, onSelect }) {
  const mesh = airplaneMesh();
  let enabled = false;
  let colors = null;
  let themeId = null;

  let live = null; // last live response + query circle
  let world = null; // last world response
  let planes = []; // merged aircraft records
  let byHex = new Map();
  let lastLive = 0;
  let lastWorld = 0;
  let inflight = { live: false, world: false };
  let pollTimer = 0;
  let raf = 0;
  let lastDraw = 0;
  let lastFollow = 0;
  let frame = 0;
  let sel = null; // selected aircraft state

  const panel = createFlightPanel(panelEl, {
    onClose: () => select(null),
    onFollow: () => {
      if (!sel) return;
      sel.following = !sel.following;
      if (sel.following) followNow(true);
      renderPanel();
    },
  });

  overlay.tooltip('flights', (p) => {
    const alt = p.ground ? 'on ground' : Number.isFinite(p.alt) ? `${Math.round(p.alt).toLocaleString()} ft` : '';
    return `<b>${esc(p.flight || p.reg || p.hex.toUpperCase())}</b>${p.type ? ` · ${esc(p.type)}` : ''}<br>${alt}${
      Number.isFinite(p.gs) ? ` · ${Math.round(p.gs)} kt` : ''}`;
  });

  // --- Fetching -------------------------------------------------------------

  function viewRadiusNm() {
    const c = map.getCenter();
    const b = map.getBounds();
    const corners = [b.getNorthWest(), b.getNorthEast(), b.getSouthWest(), b.getSouthEast()];
    const r = Math.max(...corners.map((p) => geo.distanceM([c.lng, c.lat], [p.lng, p.lat]))) / 1852;
    // Globe views of the whole planet can report odd bounds; treat them as "everything".
    return Number.isFinite(r) && map.getZoom() > 2.5 ? r : 10_000;
  }

  async function poll() {
    if (!enabled) return;
    const now = Date.now();
    const r = viewRadiusNm();
    const c = map.getCenter().wrap();

    if (r > LIVE_MAX_NM && now - lastWorld > WORLD_EVERY_MS && !inflight.world) {
      inflight.world = true;
      lastWorld = now;
      getJson('/api/flights/world')
        .then((d) => { world = d; merge(); })
        .catch((err) => onStatus(`Flights (world): ${err.message}`))
        .finally(() => { inflight.world = false; });
    }
    // Live data around the center is useful until the view gets continent-sized.
    if (r < 1500 && now - lastLive > LIVE_EVERY_MS && !inflight.live) {
      inflight.live = true;
      lastLive = now;
      const q = `lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}&r=${Math.ceil(Math.min(r, LIVE_MAX_NM))}`;
      getJson(`/api/flights/live?${q}`)
        .then((d) => { live = d; merge(); })
        .catch((err) => {
          lastLive = Date.now() + 20_000; // back off before trying again
          onStatus(`Flights (live): ${err.message}`);
        })
        .finally(() => { inflight.live = false; });
    } else if (r >= 1500 && live) {
      live = null;
      merge();
    }
  }

  function merge() {
    const next = new Map();
    const liveCenter = live && live.center;
    const liveRadiusM = live ? live.radiusNm * 1852 : 0;
    if (world) {
      for (const a of world.aircraft) {
        // Inside the live circle, live data is authoritative.
        if (liveCenter && geo.distanceM(liveCenter, [a.lon, a.lat]) < liveRadiusM) continue;
        next.set(a.hex, { ...a, source: 'opensky', fixTime: world.time - a.age * 1000, maxDt: 20 * 60 });
      }
    }
    if (live) {
      for (const a of live.aircraft) {
        next.set(a.hex, { ...a, source: live.source, fixTime: live.time - a.age * 1000, maxDt: 60 });
      }
    }
    byHex = next;
    planes = [...next.values()];
    for (const p of planes) p.color = colorFor(p);

    if (sel) {
      const p = byHex.get(sel.hex);
      if (p && sel.trail.length) {
        const last = sel.trail[sel.trail.length - 1];
        if (last[0] !== p.lon || last[1] !== p.lat) sel.trail.push([p.lon, p.lat, (p.alt || 0) * FT_TO_M]);
      }
      renderPanel();
    }

    onCount(planes.length);
    const parts = [];
    if (live) parts.push(`live within ${live.radiusNm} nm (${live.source})`);
    if (world && world.aircraft.length) {
      const mins = Math.round((Date.now() - world.time) / 60000);
      parts.push(`world snapshot ${mins < 1 ? 'just now' : `${mins} min old`} (OpenSky)`);
    }
    onStatus(`✈ ${planes.length.toLocaleString()} aircraft · ${parts.join(' + ')}`);
  }

  // --- Drawing --------------------------------------------------------------

  function colorFor(p) {
    if (p.squawk === '7500' || p.squawk === '7600' || p.squawk === '7700' || p.emergency) return colors.alert;
    if (p.mil) return colors.mil;
    if (p.ground) return colors.ground;
    const t = Math.max(0, Math.min(1, (p.alt || 0) / 40000));
    return t < 0.5 ? geo.mixRgb(colors.low, colors.mid, t * 2) : geo.mixRgb(colors.mid, colors.high, (t - 0.5) * 2);
  }

  // Dead-reckon each aircraft forward from its last fix so motion is smooth.
  function predict(p, now) {
    const dt = Math.min(Math.max(0, (now - p.fixTime) / 1000), p.maxDt);
    if (p.ground || !Number.isFinite(p.gs) || !Number.isFinite(p.track) || dt === 0) return [p.lon, p.lat];
    return geo.destination([p.lon, p.lat], p.track, p.gs * KT_TO_MS * dt);
  }

  function planeSizePx(zoom) {
    if (zoom < 3) return 9;
    if (zoom < 6) return 9 + (zoom - 3) * 4;
    return 21 + Math.min(zoom - 6, 6) * 1.5;
  }

  function draw(now) {
    raf = requestAnimationFrame(draw);
    if (now - lastDraw < DRAW_EVERY_MS) return;
    lastDraw = now;
    frame++;

    const t = Date.now();
    const zoom = map.getZoom();
    const sizeScale = planeSizePx(zoom) * geo.metersPerPixel(map.getCenter().lat, zoom);
    const lift = sizeScale * 0.08; // keep the model above the ground at low zoom
    for (const p of planes) {
      const [lon, lat] = predict(p, t);
      p.pos = [lon, lat, (p.ground ? 0 : (p.alt || 0) * FT_TO_M) + lift];
    }

    const meshProps = {
      mesh,
      sizeScale,
      getPosition: (p) => p.pos,
      // [pitch, yaw, roll]; deck.gl yaw turns counter-clockwise, compass track turns clockwise.
      getOrientation: (p) => [0, -(p.track || 0), 0],
      material: { ambient: 0.55, diffuse: 0.6, shininess: 40, specularColor: [255, 255, 255] },
      updateTriggers: { getPosition: frame, getOrientation: frame, getColor: themeId },
    };

    const layers = [];
    const s = sel && byHex.get(sel.hex);
    if (s) layers.push(...selectionLayers(s));
    layers.push(new deck.SimpleMeshLayer({
      ...meshProps,
      id: 'flights:planes',
      data: planes,
      getColor: (p) => p.color,
      pickable: true,
    }));
    if (s) {
      layers.push(new deck.SimpleMeshLayer({
        ...meshProps,
        id: 'flights:selected',
        data: [s],
        sizeScale: sizeScale * 1.7,
        getColor: colors.selected,
        pickable: true,
      }));
      if (sel.following && now - lastFollow > 500) {
        lastFollow = now;
        followNow(false);
      }
    }
    overlay.set('flights', layers);
  }

  function selectionLayers(p) {
    const layers = [];
    if (sel.trail.length) {
      layers.push(new deck.PathLayer({
        id: 'flights:trail',
        data: [{ path: [...sel.trail, p.pos] }],
        getPath: (d) => d.path,
        getColor: [...colors.trail, 230],
        getWidth: 2.5,
        widthUnits: 'pixels',
        jointRounded: true,
        capRounded: true,
        wrapLongitude: true,
        updateTriggers: { getPath: frame },
      }));
    }
    const r = sel.route;
    if (r?.origin && r?.destination && sel.routePlausible) {
      const dest = [r.destination.lon, r.destination.lat];
      const dashed = deck.PathStyleExtension ? { extensions: [new deck.PathStyleExtension({ dash: true })], getDashArray: [4, 3] } : {};
      layers.push(new deck.PathLayer({
        id: 'flights:ahead',
        data: [{ path: geo.greatCircle([p.pos[0], p.pos[1]], dest, 48) }],
        getPath: (d) => d.path,
        getColor: [...colors.trail, 140],
        getWidth: 2,
        widthUnits: 'pixels',
        wrapLongitude: true,
        updateTriggers: { getPath: frame },
        ...dashed,
      }));
      const airports = [r.origin, r.destination];
      layers.push(new deck.ScatterplotLayer({
        id: 'flights:airports',
        data: airports,
        getPosition: (a) => [a.lon, a.lat],
        getRadius: 5,
        radiusUnits: 'pixels',
        getFillColor: [...colors.selected, 255],
        getLineColor: [0, 0, 0, 200],
        lineWidthMinPixels: 1.5,
        stroked: true,
      }));
      layers.push(new deck.TextLayer({
        id: 'flights:airport-labels',
        data: airports,
        getPosition: (a) => [a.lon, a.lat],
        getText: (a) => a.iata || a.icao || '',
        getSize: 13,
        getColor: [...colors.selected, 255],
        getPixelOffset: [0, -14],
        fontFamily: 'Share Tech Mono, monospace',
        fontWeight: 700,
        outlineWidth: 3,
        outlineColor: [0, 0, 0, 220],
        fontSettings: { sdf: true },
        billboard: true,
        parameters: { cullMode: 'none' }, // text is back-face culled on the globe otherwise
      }));
    }
    return layers;
  }

  // --- Selection ------------------------------------------------------------

  function followNow(animate) {
    const p = sel && byHex.get(sel.hex);
    if (!p?.pos) return;
    map.easeTo({ center: [p.pos[0], p.pos[1]], duration: animate ? 800 : 500, essential: true });
  }

  function routeProgress(p, r) {
    const o = [r.origin.lon, r.origin.lat];
    const d = [r.destination.lon, r.destination.lat];
    const here = [p.lon, p.lat];
    const flown = geo.distanceM(o, here);
    const left = geo.distanceM(here, d);
    const total = geo.distanceM(o, d);
    return {
      progress: flown / (flown + left || 1),
      // A plane far off the straight-ish line between the airports is probably on another route.
      plausible: flown + left <= total * 1.25 + 150_000,
    };
  }

  function renderPanel() {
    const p = sel && byHex.get(sel.hex);
    if (!p) return;
    if (sel.route?.origin && sel.route?.destination) {
      const { progress, plausible } = routeProgress(p, sel.route);
      sel.progress = progress;
      sel.routePlausible = plausible;
    }
    panel.render(p, sel);
  }

  async function select(hex) {
    sel = hex ? { hex, trail: [], route: null, details: null, following: false } : null;
    if (!sel) {
      panel.hide();
      return;
    }
    onSelect?.();
    const p = byHex.get(hex);
    renderPanel();
    const mine = sel;
    const tasks = [
      getJson(`/api/flights/trace/${encodeURIComponent(hex)}`).then((d) => {
        mine.trail = d.points.map(([lon, lat, alt]) => [lon, lat, alt * FT_TO_M]);
      }),
      getJson(`/api/flights/aircraft/${encodeURIComponent(hex)}`).then((d) => { mine.details = d.aircraft; }),
    ];
    if (p?.flight) {
      tasks.push(getJson(`/api/flights/route/${encodeURIComponent(p.flight)}`).then((d) => { mine.route = d.route; }));
    }
    for (const task of tasks) {
      task.catch((err) => console.warn('Flight detail failed:', err.message)).then(() => { if (sel === mine) renderPanel(); });
    }
  }

  map.on('click', (e) => {
    if (!enabled) return;
    const info = overlay.pick(e.point, PLANE_LAYERS);
    select(info?.object?.hex || null);
  });
  map.on('dragstart', () => {
    if (sel?.following) { sel.following = false; renderPanel(); }
  });
  map.on('moveend', () => {
    // Re-query live data promptly when the view moves somewhere new.
    if (live && geo.distanceM(live.center, map.getCenter().toArray()) > live.radiusNm * 1852 * 0.3) lastLive = 0;
    poll();
  });

  // --- Public API -----------------------------------------------------------

  return {
    select,
    focus: (hex) => select(hex),
    selected: () => sel?.hex ?? null,
    deselect: () => select(null),
    get: (hex) => byHex.get(hex),
    setTheme(id) {
      themeId = id;
      const f = THEMES[id].flights;
      colors = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, geo.hexToRgb(v)]));
      for (const p of planes) p.color = colorFor(p);
    },
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      if (on) {
        lastLive = lastWorld = 0;
        poll();
        pollTimer = setInterval(poll, 1000);
        raf = requestAnimationFrame(draw);
        onStatus('✈ Loading flights…');
      } else {
        clearInterval(pollTimer);
        cancelAnimationFrame(raf);
        live = world = null;
        planes = [];
        byHex = new Map();
        select(null);
        overlay.set('flights', []);
        onCount(null);
        onStatus('');
      }
    },
  };
}
