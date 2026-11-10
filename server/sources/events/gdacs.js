// GDACS (UN / EU Joint Research Centre): cyclones, floods, volcanoes, droughts
// and wildfires, each with an official Green / Orange / Red alert level based on
// expected impact on people. Earthquakes come from USGS instead (more detail).
//   EVENTS4APP -> everything current, all alert levels
//   SEARCH     -> Orange/Red events of the whole retention window (it defaults to those)

import { cached } from '../../lib/cache.js';
import { fetchJson, HttpError } from '../../lib/http.js';
import { retentionDays } from './store.js';

const API = 'https://www.gdacs.org/gdacsapi/api';
const KINDS = { TC: 'cyclone', FL: 'flood', VO: 'volcano', DR: 'drought', WF: 'wildfire' };
const LEVEL = { Green: 1, Orange: 2, Red: 3 };

// GDACS dates are UTC without a zone suffix.
const utc = (s) => (s ? Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`) : null);
const tidy = (s) => (s || '').replace(/\s+/g, ' ').replace(/[\s,]+$/, '').trim();

function title(p, kind) {
  const countries = tidy(p.country).split(',').map((c) => c.trim()).filter(Boolean);
  if (kind === 'cyclone') return tidy(p.name).replace(/-\d\d$/, ''); // "Tropical Cyclone MURASU"
  if (kind === 'volcano') return tidy(p.name).replace(/^Eruption\s+/, 'Eruption: ');
  if (countries.length > 3) return `${tidy(p.description).split(' in ')[0]} · ${countries.length} countries`;
  return tidy(p.name);
}

function toEvent(f) {
  const p = f.properties;
  const kind = KINDS[p.eventtype];
  let severity = LEVEL[p.alertlevel] || 1;
  const wind = p.eventtype === 'TC' ? p.severitydata?.severity : null;
  // GDACS rates cyclones by people at risk; a Category 3+ storm over open sea is still news.
  if (wind >= 178) severity = Math.max(severity, 2);
  const ongoing = p.iscurrent === 'true';
  const [lon, lat] = f.geometry.coordinates;
  return {
    id: `gdacs:${p.eventtype}${p.eventid}`,
    source: 'gdacs',
    kind,
    severity,
    title: title(p, kind),
    place: tidy(p.country),
    lat,
    lon,
    start: utc(p.fromdate),
    end: ongoing ? null : utc(p.todate),
    url: p.url?.report,
    summary: tidy(p.htmldescription),
    data: {
      alert: p.alertlevel,
      severityText: tidy(p.severitydata?.severitytext),
      windKmh: wind ? Math.round(wind) : undefined,
      geometry: p.url?.geometry, // fetched on demand for the selected event
      sources: [{ name: 'GDACS', url: p.url?.report }],
    },
  };
}

export const gdacs = {
  id: 'gdacs',
  name: 'GDACS',
  everyMs: 15 * 60_000,
  async fetch() {
    const from = new Date(Date.now() - retentionDays() * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const [current, recent] = await Promise.all([
      fetchJson(`${API}/events/geteventlist/EVENTS4APP`, { timeout: 30_000 }),
      fetchJson(`${API}/events/geteventlist/SEARCH?eventlist=TC;FL;VO;DR;WF&fromdate=${from}&todate=${to}&pagesize=100`, { timeout: 30_000 }),
    ]);
    const byId = new Map();
    for (const f of [...recent.features, ...current.features]) {
      if (!KINDS[f.properties.eventtype] || f.geometry?.type !== 'Point') continue;
      const e = toEvent(f);
      byId.set(e.id, e);
    }
    return [...byId.values()];
  },
};

// Shapes for a selected GDACS event: cyclone track and wind zones, flood or
// fire areas. The raw file is ~0.5 MB, so it's slimmed to what the map draws.
const round = (c) => (typeof c[0] === 'number' ? [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100] : c.map(round));

export function geometry(url) {
  if (!url?.startsWith(`${API}/polygons/getgeometry?`)) throw new HttpError(400, 'Not a GDACS geometry URL');
  return cached(`gdacs-geom:${url}`, 30 * 60_000, async () => {
    const d = await fetchJson(url, { timeout: 30_000 });
    const track = [];
    const areas = [];
    for (const f of d.features || []) {
      const cls = f.properties?.Class || '';
      const g = f.geometry;
      if (!g) continue;
      if (g.type === 'LineString' && cls.startsWith('Line_')) track.push(round(g.coordinates));
      else if (/Polygon$/.test(g.type) && (cls.startsWith('Poly_') && cls !== 'Poly_Cones')) {
        const level = cls.replace('Poly_', ''); // Green / Orange / Red wind or impact zone, or e.g. "Polygon"
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
        for (const poly of polys) areas.push({ level, polygon: round(poly) });
      }
    }
    return { track, areas };
  });
}
