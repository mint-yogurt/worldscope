// News from Wikipedia's "Current events" portal: one page per day, written by
// people, sorted into sections (armed conflicts, politics, disasters...) with
// topics like "Gaza war" and dated one-sentence items under them, each citing
// news outlets. We turn every topic into one event that collects its daily
// updates, and place it on the map from the coordinates of the articles the
// sentences link to (most specific place wins). Text is CC BY-SA.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { throttle } from '../../lib/cache.js';
import { HttpError, USER_AGENT } from '../../lib/http.js';
import * as store from './store.js';

const WIKI = 'https://en.wikipedia.org';
const DAY_MS = 86_400_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MAX_UPDATES = 15;

const SECTION_KIND = {
  'armed conflicts and attacks': 'conflict',
  'disasters and accidents': 'accident',
  'international relations': 'politics',
  'politics and elections': 'politics',
  'law and crime': 'crime',
};
const UNREST = /\b(protest(s|ers?)?|riot(s|ing|ers)?|demonstrat(ion|ions|ors)|unrest|uprising|general strike|tear gas|crackdown on (protest|demonstrat))/i;
const NATURAL = /\b(earthquake|tsunami|cyclone|typhoon|hurricane|tropical storm|flood(s|ing)?|eruption|volcan|wildfire|bushfire|drought|landslide|mudslide)/i;
const UPHEAVAL = /\b(coup|martial law|assassinat|state of emergency|declares? war|invade[sd]?|invasion)\b/i;

const pageTitle = (day) => `Portal:Current events/${day.getUTCFullYear()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}`;
const pageUrl = (title) => `${WIKI}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

// --- Wikitext -> plain text, links, sources -----------------------------------------

function linksIn(wikitext) {
  const out = [];
  for (const [, target] of wikitext.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const t = target.trim();
    if (!/^(File|Image|Category|wikt|w):/i.test(t)) out.push(t[0].toUpperCase() + t.slice(1));
  }
  return out;
}

function sourcesIn(wikitext) {
  return [...wikitext.matchAll(/\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/g)].map(([, url, label]) => ({
    url,
    name: plain(label).replace(/^\(|\)$/g, '').replace(/\s*\(?in [A-Z][a-z]+\)?$/, '').trim(),
  }));
}

function plain(wikitext) {
  return wikitext
    .replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/\{\{small\|([^}]*)\}\}/g, '($1)')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/[^\s\]]+\s*[^\]]*\]/g, '')
    .replace(/'{2,}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// A bullet that is only links (and commas) names a topic; anything else is a news item.
const isTopicLine = (wikitext) => !/\[http/.test(wikitext) && plain(wikitext.replace(/\[\[[^\]]*\]\]/g, '')).replace(/[,;\s]|\band\b/g, '') === '';

// Parses one day page into items: { section, topics: [{title, label}], text, links, sources }.
function parseDay(wikitext) {
  const items = [];
  let section = '';
  const stack = []; // topic per bullet depth
  for (const line of wikitext.split('\n')) {
    const head = line.match(/^'''(.+?)'''\s*$/) || line.match(/^;\s*(.+?)\s*$/);
    if (head) {
      section = plain(head[1]).toLowerCase();
      stack.length = 0;
      continue;
    }
    const bullet = line.match(/^(\*+)\s*(.*)$/);
    if (!bullet || !section) continue;
    const depth = bullet[1].length;
    const body = bullet[2];
    stack.length = depth - 1;
    if (isTopicLine(body)) {
      const title = linksIn(body)[0];
      if (title) stack[depth - 1] = { title, label: plain(body).split(',')[0].trim() };
      continue;
    }
    const text = plain(body);
    if (text.length < 20) continue;
    items.push({ section, topics: stack.filter(Boolean), text, links: linksIn(body), sources: sourcesIn(body) });
  }
  return items;
}

// --- API access ----------------------------------------------------------------------

// Wikimedia rate-limits by IP, harder for clients that don't say who they are.
// Requests go out one at a time with a gap (raw day pages come from cache and
// are cheaper than API queries), and a 429 waits as long as it asks.
// Set WIKIMEDIA_CONTACT (your site URL or an email) in secrets.env for better limits:
// https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy
export const userAgent = () => (process.env.WIKIMEDIA_CONTACT ? `${USER_AGENT.replace(/\)$/, '')}; ${process.env.WIKIMEDIA_CONTACT})` : USER_AGENT);
const pageGate = throttle(1000);
const apiGate = throttle(3000);

async function wiki(url, gate, parse = 'json') {
  for (let attempt = 0; ; attempt++) {
    const res = await gate(() => fetch(url, { headers: { 'User-Agent': userAgent() }, signal: AbortSignal.timeout(30_000) }));
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, Math.max(10, Number(res.headers.get('retry-after')) || 0) * 1000));
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new HttpError(res.status, `Wikipedia responded ${res.status}`);
    return parse === 'json' ? res.json() : res.text();
  }
}

// --- Article coordinates and images ------------------------------------------------

// title -> { at, info }, saved to disk so restarts don't look everything up again.
const ARTICLE_FILE = fileURLToPath(new URL('../../../data/cache/wiki-articles.json', import.meta.url));
const ARTICLE_TTL = 14 * DAY_MS;
let articleCache = null;

async function saveArticles() {
  for (const [t, v] of articleCache) if (Date.now() - v.at > ARTICLE_TTL) articleCache.delete(t);
  await mkdir(dirname(ARTICLE_FILE), { recursive: true });
  await writeFile(ARTICLE_FILE, JSON.stringify(Object.fromEntries(articleCache)));
}

// Coordinates, short description and lead image, 50 articles per query.
async function articles(titles) {
  if (!articleCache) {
    try {
      articleCache = new Map(Object.entries(JSON.parse(await readFile(ARTICLE_FILE, 'utf8'))));
    } catch {
      articleCache = new Map();
    }
  }
  const want = [...new Set(titles)].filter((t) => !(Date.now() - (articleCache.get(t)?.at || 0) < ARTICLE_TTL));
  for (let i = 0; i < want.length; i += 50) {
    const batch = want.slice(i, i + 50);
    const params = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2', redirects: '1',
      prop: 'coordinates|pageimages|description', piprop: 'thumbnail', pithumbsize: '640',
      titles: batch.join('|'),
    });
    let d;
    try {
      d = await wiki(`${WIKI}/w/api.php?${params}`, apiGate);
    } catch (err) {
      console.warn(`[events] Wikipedia article lookup: ${err.message}`);
      break; // keep what we have; the rest is retried next run
    }
    const canonical = new Map(batch.map((t) => [t, t]));
    for (const n of [...(d.query?.normalized || []), ...(d.query?.redirects || [])]) {
      for (const [orig, cur] of canonical) if (cur === n.from) canonical.set(orig, n.to);
    }
    const pages = new Map((d.query?.pages || []).map((p) => [p.title, p]));
    for (const [orig, cur] of canonical) {
      const p = pages.get(cur);
      const c = p?.coordinates?.find((x) => x.primary) || p?.coordinates?.[0];
      articleCache.set(orig, {
        at: Date.now(),
        info: p && !p.missing ? {
          title: p.title,
          description: p.description,
          coord: c && { lat: c.lat, lon: c.lon },
          image: p.thumbnail?.source,
        } : null,
      });
    }
    await saveArticles();
  }
  return (title) => articleCache.get(title)?.info;
}

// How specific a place is, from its short description: 3 = town, site, building;
// 2 = region, sea; 1 = country.
function specificity(info) {
  const desc = info.description || '';
  if (/^(country|sovereign state|island (country|nation)|transcontinental country|landlocked country|continent)\b|\bocean\b/i.test(desc)) return 1;
  if (/\b(state|province|region|oblast|governorate|department|county|district|territory|prefecture|canton|voivodeship|krai|autonomous community)\b(?! capital)/i.test(desc.split(/ (of|in) /)[0])
    || /^(strait|sea|gulf|bay|body of water|channel|peninsula|desert|mountain range|river)\b/i.test(desc)) return 2;
  return 3;
}

function pickPlace(titles, lookup) {
  let best = null;
  for (const t of titles) {
    const info = lookup(t);
    if (!info?.coord) continue;
    const score = specificity(info);
    if (!best || score > best.score) best = { title: info.title, description: info.description, lat: info.coord.lat, lon: info.coord.lon, score };
  }
  return best;
}

// Flags, coats of arms and logos say nothing about the news.
const usefulImage = (url) => url && !/(Flag_of|Coat_of_arms|Emblem_of|Seal_of|Logo|_logo|Locator|location_map|Map_of)/i.test(url);

// --- Deaths and severity -----------------------------------------------------------

const WORD_NUMBERS = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, 'a dozen': 12, dozens: 24, scores: 40, hundreds: 200, thousands: 2000 };
function deaths(text) {
  let max = 0;
  const num = String.raw`(\d[\d,]*|a dozen|dozens|scores|hundreds|thousands|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
  const patterns = [
    new RegExp(String.raw`(?:killing|kills|killed)\s+(?:at least |more than |over |nearly |about |around )?${num}`, 'gi'),
    new RegExp(String.raw`${num}\s+(?:\w+\s+){0,3}(?:are |were |have been |being )?(?:killed|dead|die|died|deaths)`, 'gi'),
    new RegExp(String.raw`death toll (?:\w+\s+){0,4}${num}`, 'gi'),
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const raw = m[1].toLowerCase();
      const n = WORD_NUMBERS[raw] ?? Number(raw.replace(/,/g, ''));
      if (n > max && n < 1e6) max = n;
    }
  }
  return max;
}

function classify(section, text, topicText) {
  let kind = SECTION_KIND[section] || 'news';
  if (kind !== 'conflict' && (UNREST.test(text) || UNREST.test(topicText))) kind = 'unrest';
  const dead = deaths(text);
  let severity = { conflict: 2, unrest: 2, politics: 2, accident: 2, crime: 1, news: 1 }[kind];
  if (dead >= (kind === 'accident' ? 20 : kind === 'crime' ? 5 : 10)) severity = Math.min(3, severity + 1);
  if (kind === 'politics' && UPHEAVAL.test(text)) severity = 3;
  return { kind, severity, dead };
}

// A headline from a sentence: its first clause, cut at a word near 70 characters.
function shortTitle(text) {
  const clause = text.split(/[.;:]\s|,\s(?:killing|leaving|after|while|as|following)\b/)[0].replace(/\.$/, '');
  return clause.length <= 70 ? clause : `${clause.slice(0, 70).replace(/\s+\S*$/, '')}…`;
}

// --- Ingest ------------------------------------------------------------------------

// Missing page (e.g. today's, early in the UTC day) -> null.
const fetchDay = (day) => wiki(`${WIKI}/w/index.php?title=${encodeURIComponent(pageTitle(day).replace(/ /g, '_'))}&action=raw`, pageGate, 'text');

const readDays = new Set(); // days read successfully since the server started

// Nature-made disasters already come from USGS / GDACS / EONET; skip news items about them.
function coveredByHazardFeeds(place, text, dayStart) {
  if (!NATURAL.test(text)) return false;
  return store.nearby(place.lat, place.lon, 600, dayStart - 3 * DAY_MS).some((e) => e.source !== 'wiki');
}

export const wikipedia = {
  id: 'wiki',
  name: 'Wikipedia Current events',
  everyMs: 30 * 60_000,
  async fetch() {
    const today = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS);
    // Read every day of the window once, then keep re-reading the last 3 (pages keep being edited).
    const days = Array.from({ length: store.retentionDays() }, (_, i) => new Date(today - i * DAY_MS))
      .filter((day, i) => i < 3 || !readDays.has(day.getTime()))
      .reverse();

    const parsed = [];
    for (const day of days) {
      const wikitext = await fetchDay(day).catch((err) => { console.warn(`[events] Wikipedia ${pageTitle(day)}: ${err.message}`); return null; });
      if (wikitext) {
        parsed.push({ day, items: parseDay(wikitext) });
        readDays.add(day.getTime());
      }
    }
    // Group by topic (the deepest one above each item); untopiced items stand alone.
    const groups = new Map();
    for (const { day, items } of parsed) {
      for (const item of items) {
        const topic = item.topics.at(-1);
        const key = topic ? `wiki:${hash(topic.title)}` : `wiki:${day.toISOString().slice(0, 10)}-${hash(item.text.toLowerCase().slice(0, 80))}`;
        const g = groups.get(key) || { id: key, topic, section: item.section, entries: [] };
        g.entries.push({ day, ...item });
        groups.set(key, g);
      }
    }

    // Place candidates: the latest day's sentences first, then the topics above them.
    for (const g of groups.values()) {
      g.latest = g.entries.at(-1);
      g.latestDay = g.entries.filter((e) => e.day === g.latest.day);
      g.topicTitles = [...g.latest.topics].reverse().map((t) => t.title);
      g.candidates = [...g.latestDay.flatMap((e) => e.links), ...g.topicTitles];
    }
    const lookup = await articles([...groups.values()].flatMap((g) => g.candidates));

    const events = [];
    for (const g of groups.values()) {
      const { latest, latestDay, topicTitles } = g;
      const place = pickPlace(g.candidates, lookup);
      if (!place) continue;
      const dayStart = latest.day.getTime();
      if (coveredByHazardFeeds(place, latestDay.map((e) => e.text).join(' '), dayStart)) continue;

      const topicText = latest.topics.map((t) => t.label).join(' ');
      let kind = 'news';
      let severity = 1;
      for (const e of latestDay) {
        const c = classify(e.section, e.text, topicText);
        if (c.severity > severity || kind === 'news') ({ kind, severity } = c);
      }

      // Merge this run's days into the updates already stored for the topic.
      const existing = store.get(g.id);
      const fresh = g.entries.map((e) => ({ day: e.day.toISOString().slice(0, 10), text: e.text, sources: e.sources }));
      const freshDays = new Set(fresh.map((u) => u.day));
      const updates = [...fresh, ...(existing?.data.updates || []).filter((u) => !freshDays.has(u.day))]
        .sort((a, b) => b.day.localeCompare(a.day))
        .slice(0, MAX_UPDATES);
      const firstDay = Date.parse(updates.at(-1).day);
      const lastDayEnd = Date.parse(updates[0].day) + DAY_MS - 1;
      // New topics on today's page count from when we first saw them, so they pulse as new.
      const start = Math.min(existing?.start ?? Infinity, firstDay === today.getTime() ? Date.now() : firstDay + DAY_MS / 2);

      const topicImage = topicTitles.map((t) => lookup(t)?.image).find(usefulImage);
      events.push({
        id: g.id,
        source: 'wiki',
        kind,
        severity,
        title: g.topic ? g.topic.label : shortTitle(latest.text),
        place: [place.title, place.description].filter(Boolean).join(' · '),
        lat: place.lat,
        lon: place.lon,
        start: Math.min(start, lastDayEnd),
        end: lastDayEnd,
        url: g.topic ? pageUrl(g.topic.title) : pageUrl(pageTitle(latest.day)),
        summary: latest.text,
        data: {
          topics: latest.topics.map((t) => ({ label: t.label, url: pageUrl(t.title) })),
          updates,
          image: topicImage,
          deaths: deaths(latestDay.map((e) => e.text).join(' ')) || undefined,
          sources: [
            ...latestDay.flatMap((e) => e.sources).filter((s, i, a) => a.findIndex((x) => x.url === s.url) === i).slice(0, 6),
            { name: 'Wikipedia', url: pageUrl(pageTitle(latest.day)) },
          ],
        },
      });
    }
    return events;
  },
};
