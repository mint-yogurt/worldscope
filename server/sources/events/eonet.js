// NASA EONET: natural events curated from other feeds. Used for volcanoes
// (Smithsonian / USGS volcano reports) and large wildfires. Prescribed burns
// and small fires are skipped; storms and sea ice are covered elsewhere or noise.

import { fetchJson } from '../../lib/http.js';
import { retentionDays } from './store.js';

const API = 'https://eonet.gsfc.nasa.gov/api/v3/events/geojson';
const MIN_FIRE_ACRES = 5000;

export const eonet = {
  id: 'eonet',
  name: 'NASA EONET',
  everyMs: 30 * 60_000,
  async fetch() {
    const d = await fetchJson(`${API}?status=all&days=${retentionDays()}&category=volcanoes,wildfires`, { timeout: 45_000 });
    // Events with several dated positions come as one feature per position.
    const byId = new Map();
    for (const f of d.features) {
      if (f.geometry?.type !== 'Point') continue;
      const p = f.properties;
      const list = byId.get(p.id) || [];
      list.push(f);
      byId.set(p.id, list);
    }
    const events = [];
    for (const list of byId.values()) {
      list.sort((a, b) => Date.parse(a.properties.date) - Date.parse(b.properties.date));
      const latest = list.at(-1);
      const p = latest.properties;
      const kind = p.categories[0].id === 'volcanoes' ? 'volcano' : 'wildfire';
      const acres = p.magnitudeUnit === 'acres' ? p.magnitudeValue : null;
      if (kind === 'wildfire' && (/prescribed|\bRX\b/i.test(p.title) || !(acres >= MIN_FIRE_ACRES))) continue;
      const [lon, lat] = latest.geometry.coordinates;
      events.push({
        id: `eonet:${p.id}`,
        source: 'eonet',
        kind,
        severity: kind === 'volcano' || acres >= 100_000 ? 2 : 1,
        title: p.title,
        place: null,
        lat,
        lon,
        start: Date.parse(list[0].properties.date),
        end: p.closed ? Date.parse(p.closed) : null,
        url: p.sources?.[0]?.url,
        data: {
          acres: acres ?? undefined,
          sources: (p.sources || []).map((s) => ({ name: s.id, url: s.url })),
        },
      });
    }
    return events;
  },
};
