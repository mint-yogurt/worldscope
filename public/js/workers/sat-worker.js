// Satellite orbit propagation (SGP4 via satellite.js), off the main thread.
// Messages in:  { type: 'load', sats }            -> { type: 'loaded', count }
//               { type: 'positions', time, id }   -> { type: 'positions', time, id, positions }
//                   positions: Float32Array [lon, lat, altKm] per satellite (NaN = failed)
//               { type: 'orbit', index, time, id } -> { type: 'orbit', id, path, speed }
// Only the modules we need are imported, not the package index (which pulls in WASM).

import { json2satrec } from 'https://unpkg.com/satellite.js@7.1.0/dist/io.js';
import { propagate, gstime } from 'https://unpkg.com/satellite.js@7.1.0/dist/propagation.js';
import { eciToGeodetic } from 'https://unpkg.com/satellite.js@7.1.0/dist/transforms.js';

const DEG = 180 / Math.PI;
let satrecs = [];

function geodeticAt(satrec, date, gmst) {
  const pv = propagate(satrec, date);
  if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
  const g = eciToGeodetic(pv.position, gmst);
  return { lon: g.longitude * DEG, lat: g.latitude * DEG, alt: g.height, velocity: pv.velocity };
}

self.onmessage = ({ data }) => {
  if (data.type === 'load') {
    satrecs = data.sats.map((omm) => {
      try { return json2satrec(omm); } catch { return null; }
    });
    self.postMessage({ type: 'loaded', count: satrecs.filter(Boolean).length });
    return;
  }

  if (data.type === 'positions') {
    const date = new Date(data.time);
    const gmst = gstime(date);
    const out = new Float32Array(satrecs.length * 3).fill(NaN);
    for (let i = 0; i < satrecs.length; i++) {
      if (!satrecs[i]) continue;
      const g = geodeticAt(satrecs[i], date, gmst);
      if (!g || !(g.alt > 80)) continue; // decayed or bad elements
      out[i * 3] = g.lon;
      out[i * 3 + 1] = g.lat;
      out[i * 3 + 2] = g.alt;
    }
    self.postMessage({ type: 'positions', time: data.time, id: data.id, positions: out }, [out.buffer]);
    return;
  }

  if (data.type === 'orbit') {
    // One full revolution: half behind, half ahead of now.
    const satrec = satrecs[data.index];
    if (!satrec) return;
    const periodMs = ((2 * Math.PI) / satrec.no) * 60_000; // satrec.no is rad/min
    const steps = 180;
    const path = [];
    for (let s = 0; s <= steps; s++) {
      const date = new Date(data.time + (s / steps - 0.5) * periodMs);
      const g = geodeticAt(satrec, date, gstime(date));
      if (g) path.push([g.lon, g.lat, g.alt]);
    }
    const now = geodeticAt(satrec, new Date(data.time), gstime(new Date(data.time)));
    const v = now?.velocity;
    self.postMessage({
      type: 'orbit', id: data.id, path, periodMin: periodMs / 60_000,
      speed: v ? Math.hypot(v.x, v.y, v.z) : null,
    });
  }
};
