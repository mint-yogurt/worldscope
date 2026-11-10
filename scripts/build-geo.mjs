// Builds the static geography files. Run by hand when the source data changes:
//   node scripts/build-geo.mjs
// Output (kept in the project, nothing here runs on the server):
//   public/geo/countries.json  shapes and facts per country, used by browser and server
//   server/geo/cities.json     towns over 15,000 people, for search
// Sources: Natural Earth (public domain), GeoNames (CC BY 4.0), Wikidata (CC0).

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';
const GEONAMES = 'https://download.geonames.org/export/dump';
const WIKIDATA = 'https://www.wikidata.org/w/api.php';
const UA = 'WorldScope/0.1 (personal non-commercial map project)';
const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

const round = (v) => Math.round(v * 100) / 100;
const text = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
};

// Keep two decimals (about 1 km), which matches the detail of the 1:50m shapes.
function ring(points) {
  const out = [];
  for (const [lon, lat] of points) {
    const p = [round(lon), round(lat)];
    const last = out.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

async function citiesAndCapitals() {
  // The zip holds one file: skip its local header and inflate the rest.
  const zip = Buffer.from(await (await fetch(`${GEONAMES}/cities15000.zip`)).arrayBuffer());
  const start = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28);
  const body = inflateRawSync(zip.subarray(start)).toString('utf8');
  const zones = new Map(); // iso -> time zone of the capital, or else the biggest city
  const biggest = new Map();
  const cities = [];
  for (const line of body.split('\n')) {
    const f = line.split('\t');
    if (f.length < 18) continue;
    const [name, ascii, lat, lon, code, iso, pop, tz] = [f[1], f[2], f[4], f[5], f[7], f[8], f[14], f[17]];
    cities.push([name, ascii === name ? 0 : ascii, Number(lon), Number(lat), iso, Number(pop)]);
    if (code === 'PPLC') zones.set(iso, tz);
    if (Number(pop) > (biggest.get(iso)?.pop || 0)) biggest.set(iso, { pop: Number(pop), tz });
  }
  for (const [iso, { tz }] of biggest) if (!zones.has(iso)) zones.set(iso, tz);
  cities.sort((a, b) => b[5] - a[5]);
  return { cities, zones };
}

async function countryFacts() {
  const facts = new Map();
  for (const line of (await text(`${GEONAMES}/countryInfo.txt`)).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    facts.set(f[0], { capital: f[5], areaKm2: Number(f[6]) || null, currency: f[11], languages: f[15] });
  }
  return facts;
}

// English Wikipedia titles by Wikidata id, so "Georgia" means the country.
async function wikipediaTitles(ids) {
  const titles = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const q = new URLSearchParams({
      action: 'wbgetentities', format: 'json', props: 'sitelinks', sitefilter: 'enwiki', ids: ids.slice(i, i + 50).join('|'),
    });
    const d = JSON.parse(await text(`${WIKIDATA}?${q}`));
    for (const [id, e] of Object.entries(d.entities)) if (e.sitelinks?.enwiki) titles.set(id, e.sitelinks.enwiki.title);
  }
  return titles;
}

const ne = JSON.parse(await text(NE));
const { cities, zones } = await citiesAndCapitals();
const facts = await countryFacts();
const titles = await wikipediaTitles(ne.features.map((f) => f.properties.WIKIDATAID).filter(Boolean));

const countries = ne.features.map(({ properties: p, geometry: g }) => {
  // ISO_A2 is -99 for France and a few others; the _EH field repairs those.
  const iso = /^[A-Z]{2}$/.test(p.ISO_A2_EH) ? p.ISO_A2_EH : null;
  const f = facts.get(iso) || {};
  const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return {
    id: iso || p.ADM0_A3,
    iso,
    name: p.NAME_EN || p.NAME,
    long: p.FORMAL_EN || p.NAME_LONG,
    region: p.SUBREGION,
    pop: p.POP_EST,
    capital: f.capital || null,
    tz: zones.get(iso) || null,
    areaKm2: f.areaKm2 || null,
    currency: f.currency || null,
    languages: f.languages || null,
    wiki: titles.get(p.WIKIDATAID) || null,
    polygons: polygons.map((rings) => rings.map(ring).filter((r) => r.length >= 4)).filter((rings) => rings.length),
  };
}).sort((a, b) => a.name.localeCompare(b.name));

mkdirSync(root('public/geo'), { recursive: true });
mkdirSync(root('server/geo'), { recursive: true });
writeFileSync(root('public/geo/countries.json'), JSON.stringify(countries));
writeFileSync(root('server/geo/cities.json'), JSON.stringify(cities));
console.log(`${countries.length} countries (${countries.filter((c) => !c.iso).length} without ISO code), ${cities.length} cities`);
