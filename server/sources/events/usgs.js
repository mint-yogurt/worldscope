// USGS earthquakes (public domain). Magnitude 5+ only: smaller ones happen
// dozens of times a day and are rarely news. The day feed is polled every few
// minutes; the month feed fills the store on the first run.

import { fetchJson } from '../../lib/http.js';

const FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';
const MIN_MAG = 5;

function severity(p) {
  if (p.mag >= 7 || p.alert === 'orange' || p.alert === 'red') return 3;
  if (p.mag >= 6 || p.alert === 'yellow' || p.tsunami) return 2;
  return 1;
}

export const usgs = {
  id: 'usgs',
  name: 'USGS',
  everyMs: 5 * 60_000,
  async fetch({ first }) {
    const d = await fetchJson(`${FEED}/4.5_${first ? 'month' : 'day'}.geojson`, { timeout: 30_000 });
    return d.features
      .filter((f) => f.properties.mag >= MIN_MAG && f.properties.type === 'earthquake')
      .map((f) => {
        const p = f.properties;
        const [lon, lat, depthKm] = f.geometry.coordinates;
        return {
          id: `usgs:${f.id}`,
          source: 'usgs',
          kind: 'quake',
          severity: severity(p),
          title: `M ${p.mag.toFixed(1)} earthquake`,
          place: p.place,
          lat,
          lon,
          start: p.time,
          end: p.time,
          url: p.url,
          data: {
            magnitude: p.mag,
            magType: p.magType,
            depthKm,
            tsunami: !!p.tsunami,
            alert: p.alert, // USGS PAGER impact estimate: green / yellow / orange / red
            felt: p.felt,
            intensity: p.mmi,
            sources: [{ name: 'USGS', url: p.url }],
          },
        };
      });
  },
};
