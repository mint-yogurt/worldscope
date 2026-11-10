// Small geo/color helpers shared by data layers. Points are [lon, lat].

const R = 6371008.8; // mean Earth radius, meters
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function distanceM([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Point reached by travelling `distM` meters from [lon, lat] on initial bearing `bearingDeg`.
export function destination([lon, lat], bearingDeg, distM) {
  const d = distM / R;
  const b = rad(bearingDeg);
  const p1 = rad(lat);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = rad(lon) + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [((deg(l2) + 540) % 360) - 180, deg(p2)];
}

// Great-circle path between two points as `n + 1` [lon, lat] vertices.
export function greatCircle(a, b, n = 64) {
  const [l1, p1, l2, p2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const d = distanceM(a, b) / R;
  if (d < 1e-9) return [a, b];
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    out.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.hypot(x, y)))]);
  }
  return out;
}

// Point where the Sun is directly overhead, [lon, lat] (low-precision almanac, ~0.01°).
export function subsolarPoint(date = new Date()) {
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 864e5; // days since J2000
  const g = rad(357.529 + 0.98560028 * d);
  const q = 280.459 + 0.98564736 * d;
  const L = rad(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const e = rad(23.439 - 0.00000036 * d);
  const ra = deg(Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)));
  const dec = deg(Math.asin(Math.sin(e) * Math.sin(L)));
  const gmst = (280.46061837 + 360.98564736629 * d) % 360;
  return [((ra - gmst + 540) % 360) - 180, dec];
}

// Sun elevation in degrees at a point, given the subsolar point.
export function sunElevation(lon, lat, [sunLon, sunLat]) {
  const s = Math.sin(rad(lat)) * Math.sin(rad(sunLat)) + Math.cos(rad(lat)) * Math.cos(rad(sunLat)) * Math.cos(rad(lon - sunLon));
  return deg(Math.asin(Math.max(-1, Math.min(1, s))));
}

// Latitude for a row of a Web Mercator image `height` px tall covering ±85.0511°.
export function mercatorRowLat(y, height) {
  return deg(Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / height))));
}

// Ground meters covered by one screen pixel (MapLibre uses 512 px tiles).
export function metersPerPixel(lat, zoom) {
  return (2 * Math.PI * 6378137 * Math.cos(rad(lat))) / (512 * 2 ** zoom);
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mixRgb(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}

// On the globe, deck.gl draws things on the far side of the Earth on top of it.
// Returns a test for [lon, lat, altKm] -> true if the Earth blocks it from view,
// or null when nothing needs hiding (flat map, or zoomed in past maxZoom). Treats the camera
// as far away: a point is blocked if it's on the far hemisphere and its distance
// from the view axis is less than Earth's radius.
export function globeOccluder(map, maxZoom = 5) {
  if (map.getProjection?.()?.type !== 'globe' || map.getZoom() > maxZoom) return null;
  const c = map.getCenter();
  const la = rad(c.lat);
  const lo = rad(c.lng);
  const view = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  return ([lon, lat, altKm = 0]) => {
    const pla = rad(lat);
    const plo = rad(lon);
    const cosTheta = view[0] * Math.cos(pla) * Math.cos(plo) + view[1] * Math.cos(pla) * Math.sin(plo) + view[2] * Math.sin(pla);
    if (cosTheta >= 0) return false;
    const r = 1 + (altKm * 1000) / R;
    return r * Math.sqrt(1 - cosTheta * cosTheta) < 1;
  };
}
