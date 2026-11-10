// "Related coverage" for an event's panel: recent news articles with preview
// images from the GDELT DOC API. Asked on demand when someone opens an event,
// never for the markers themselves: GDELT allows one request per 5 seconds
// and often refuses even that, so this is strictly best-effort.

import { cached, throttle } from '../../lib/cache.js';
import { fetchJson } from '../../lib/http.js';

const DOC = 'https://api.gdeltproject.org/api/v2/doc/doc';
const DAY_MS = 86_400_000;
const gate = throttle(6000);

const shortName = (s) => (s || '').split(/[,(·]/)[0].trim();
const gdeltTime = (ms) => new Date(ms).toISOString().replace(/\D/g, '').slice(0, 14);

const KIND_WORDS = {
  conflict: '(attack OR strike OR military OR killed)',
  unrest: '(protest OR protesters OR demonstration)',
  politics: '(government OR election OR minister OR president)',
  accident: '(killed OR crash OR accident OR dead)',
  crime: '(police OR court OR arrested)',
  news: '',
  flood: '(flood OR flooding)',
  volcano: '(volcano OR eruption)',
  wildfire: '(wildfire OR fire)',
  drought: 'drought',
};
const ADMIN = /\s+(Governorate|Oblast|Province|State|Region|District|County|Department|Prefecture|Municipality)$/i;
const phrase = (s) => (/\s/.test(s) ? `"${s}"` : s);

// Queries to try in order, most specific first: the topic's own name when it's
// short (e.g. "Strait of Hormuz"), then the place plus words for the kind of event.
function queriesFor(e) {
  const place = shortName(e.place).replace(ADMIN, '');
  if (e.kind === 'quake') return [`earthquake ${phrase((e.place || '').split(',').at(-1).trim())}`];
  if (e.kind === 'cyclone') return [`${phrase(shortName(e.title.replace(/^Tropical Cyclone\s+/i, '')))} (cyclone OR typhoon OR hurricane OR storm)`];
  const out = [];
  const topic = e.data?.topics?.at(-1)?.label
    ?.replace(/^\d{4}(–\d{2,4})?\s+/, '')
    .replace(/\s+(crisis|war|protests?|conflict|unrest|election|elections|attack|strikes?|incident|event)$/i, '')
    .trim();
  if (topic && topic.split(/\s+/).length <= 4 && topic.length >= 4) out.push(phrase(topic));
  if (place.length >= 3) out.push(`${phrase(place)} ${KIND_WORDS[e.kind] ?? ''}`.trim());
  return [...new Set(out)].map((q) => `${q} sourcelang:english`);
}

async function search(query, from, to) {
  const params = new URLSearchParams({
    query, mode: 'artlist', format: 'json', maxrecords: '20', sort: 'hybridrel',
    startdatetime: gdeltTime(from), enddatetime: gdeltTime(to),
  });
  const get = () => gate(() => fetchJson(`${DOC}?${params}`, { timeout: 20_000 }));
  // One retry: GDELT's 429s are frequent but usually brief.
  const d = await get().catch(async (err) => {
    if (err.status !== 429) throw err;
    await new Promise((r) => setTimeout(r, 10_000));
    return get();
  });
  const titles = new Set();
  const articles = [];
  for (const a of d.articles || []) {
    // Syndicated copies differ only by a " | Station name" or " - Site" suffix.
    const key = a.title.split(/\s[|–-]\s/)[0].toLowerCase().replace(/\W+/g, '');
    if (titles.has(key)) continue;
    titles.add(key);
    articles.push({ title: a.title, url: a.url, domain: a.domain, image: a.socialimage || null, seen: a.seendate });
  }
  // Articles with pictures first: they make the panel.
  return articles.sort((a, b) => (b.image ? 1 : 0) - (a.image ? 1 : 0)).slice(0, 6);
}

export function related(event) {
  // Coverage around the latest development, not the whole history of a long story.
  const latest = Date.parse(event.data?.updates?.[0]?.day) || Math.min(event.end || event.start, Date.now());
  const from = Math.max(event.start, latest) - 2 * DAY_MS;
  const to = Math.min(Date.now(), latest + 2 * DAY_MS);
  return cached(`gdelt:${event.id}:${latest}`, 60 * 60_000, async () => {
    for (const query of queriesFor(event)) {
      const articles = await search(query, from, to);
      if (articles.length >= 2) return { query, articles };
    }
    return { query: null, articles: [] };
  });
}
