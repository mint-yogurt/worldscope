// Groups points that would overlap on screen at a given zoom. Any layer with
// { lon, lat } points can use it.

const TAU = Math.PI * 2;
const WORLD_PX = 512; // width of the world at zoom 0 (MapLibre's tile size)
const MAX_LAT = 85.05;

const toX = (lon) => (lon + 180) / 360;
const toY = (lat) => {
  const s = Math.sin((Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * TAU) / 360);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (2 * TAU);
};
const toLon = (x) => x * 360 - 180;
const toLat = (y) => (Math.atan(Math.sinh(TAU / 2 - y * TAU)) * 360) / TAU;

// Each point in turn collects its unclaimed neighbors within `radiusPx`.
// Returns { singles: [point], clusters: [{ lon, lat, members: [point] }] }.
export function clusterPoints(points, zoom, radiusPx) {
  const scale = WORLD_PX * 2 ** zoom;
  const cellKey = (cx, cy) => cx * 1e7 + cy;
  const grid = new Map(); // cell -> indices of the points in it
  const xs = new Float64Array(points.length);
  const ys = new Float64Array(points.length);
  points.forEach((p, i) => {
    xs[i] = toX(p.lon) * scale;
    ys[i] = toY(p.lat) * scale;
    const key = cellKey(Math.floor(xs[i] / radiusPx), Math.floor(ys[i] / radiusPx));
    const cell = grid.get(key);
    if (cell) cell.push(i);
    else grid.set(key, [i]);
  });

  const claimed = new Uint8Array(points.length);
  const singles = [];
  const clusters = [];
  points.forEach((point, i) => {
    if (claimed[i]) return;
    claimed[i] = 1;
    const near = [i];
    const cx = Math.floor(xs[i] / radiusPx);
    const cy = Math.floor(ys[i] / radiusPx);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(cellKey(cx + dx, cy + dy)) || []) {
          if (!claimed[j] && Math.hypot(xs[j] - xs[i], ys[j] - ys[i]) <= radiusPx) {
            claimed[j] = 1;
            near.push(j);
          }
        }
      }
    }
    if (near.length === 1) {
      singles.push(point);
      return;
    }
    const mid = (values) => near.reduce((sum, j) => sum + values[j], 0) / near.length / scale;
    clusters.push({ lon: toLon(mid(xs)), lat: toLat(mid(ys)), members: near.map((j) => points[j]) });
  });
  return { singles, clusters };
}

// Fits the map to a cluster, which is what splits it apart.
export function zoomToCluster(map, cluster, { padding = 90, maxZoom = 15 } = {}) {
  const lons = cluster.members.map((p) => p.lon);
  const lats = cluster.members.map((p) => p.lat);
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding, maxZoom, duration: 800 });
}
