# WorldScope — feature map & data sources

Research pass, 2026-11-03. Nothing built yet. Items marked **⚠ verify** came from
secondary sources or had conflicting numbers; check them against the live docs
before writing code that depends on them.

---

## 0. Big-picture decisions

### Rendering stack (recommendation)
| Piece | Pick | Why |
|---|---|---|
| Map engine | **MapLibre GL JS** (open-source fork of Mapbox GL) | Vector + raster layers, globe projection, fully styleable, free, no key. |
| 3D objects / heavy overlays | **deck.gl** on top of MapLibre | `ScenegraphLayer` draws glTF 3D plane/ship models; `PathLayer`/`TripsLayer` for route trails; handles 10k+ moving objects on the GPU. |
| Satellite orbits | **satellite.js** | Propagates TLE/OMM orbits in the browser (SGP4). |
| Sun/moon/terminator/eclipses | **astronomy-engine** | Pure JS ephemeris; lets us draw the day/night line and compute sky events locally. |

Alternative considered: **CesiumJS** (true 3D globe, built-in satellite/plane
support). More "wow" for 3D, but heavier, harder to restyle with CSS, and
Windy-style 2D overlays are more awkward. MapLibre + deck.gl is the better fit
for a themeable, Windy-like map.

### We need a small backend, even for local testing
Opening `index.html` straight from disk (`file://`) will break quickly:
- ES modules and many `fetch()` calls refuse to run from `file://`.
- Several sources **don't send CORS headers** (browser can't call them directly).
- Some need **API keys** we must not ship to the browser (aisstream, Windy webcams, ACLED, NASA).
- The **event database / time travel** is a backend by definition.

So the plan is: static frontend + one small local server that (1) serves the
page, (2) proxies + caches the APIs, (3) holds keys, (4) runs ingest jobs into
the event DB. Same shape later on the real website.

**Backend language: Node.js**, both locally and on the production server.
Checked on this dev machine (2026-11-03): Node.js **v24.20.0** and npm **11.19.0**
are already installed, so nothing extra to install. (Python 3.11.9 is also present
but not needed.) Same language as the frontend, one runtime everywhere.

DB: **SQLite** to start (zero setup; Node 24 ships a built-in `node:sqlite`
module, or use `better-sqlite3`), move to **Postgres + PostGIS** when hosted.

### Themes ("matrix", "red & gold", "halloween", …)
A theme = three things switched together:
1. CSS custom properties on `<html data-theme="matrix">` (UI panels, fonts, glow).
2. A MapLibre **style JSON variant** (map colors live in the style, not CSS).
3. Overlay palettes (marker colors, weather color ramps, plane model tint).
Optional per-theme effects layer (e.g. falling-code canvas for Matrix, fog/bats for Halloween).

---

## 1. Base map layers

| Source | What | Key? | License / notes |
|---|---|---|---|
| **OpenFreeMap** `tiles.openfreemap.org/styles/liberty` (also `bright`, `positron`) | OSM street map, vector | No | No request limits, no sign-up. OSM/OpenMapTiles attribution. "As is", may change → self-host option exists. |
| **NASA GIBS** (WMTS, `epsg3857`, e.g. `VIIRS_SNPP_CorrectedReflectance_TrueColor`, `MODIS_Terra_CorrectedReflectance_TrueColor`) | **Daily** satellite imagery of the whole Earth, ~3 h latency | No | Public domain, credit NASA GIBS/LANCE. Max ~250 m resolution (good globally, blurry at city zoom). Has date in URL → ties into "back in time". Occasional black tiles; fall back to previous day. |
| **EOX Sentinel-2 cloudless** | Cloud-free mosaic, 10 m | No | ⚠ verify license per year (older mosaic CC BY, newer ones CC BY-NC-SA). Fine for a personal site. |
| **Esri World Imagery** | High-res satellite basemap | No (for tiles) | ⚠ verify terms; widely used with attribution, but it's not open-licensed. Good "zoomed in" option. |

Suggested toggle: **Streets (OpenFreeMap)** / **Satellite (Esri or Sentinel-2)** / **Today from space (GIBS)**.

---

## 2. Weather overlays (Windy-style)

| Source | Layers | Key? | Notes |
|---|---|---|---|
| **Open-Meteo map layer** (`@openmeteo/weather-map-layer`, `om://` protocol for MapLibre) | Temperature, wind, precipitation, cloud cover, pressure, etc. from global models | No | Best fit: built *for MapLibre*. Data CC BY 4.0; free API is for non-commercial use (~10k calls/day). ⚠ verify which variables the tile layer exposes and the layer code's license. |
| **Open-Meteo forecast API** | Point forecasts (click-a-spot popup, like Windy's side panel) | No | Same terms as above. |
| **Wind particle animation** | The signature Windy "flowing wind" look | — | We render it ourselves (WebGL particles) from u/v wind grids (Open-Meteo or GFS). Well-known technique. |
| **RainViewer** | Live radar mosaic | No | Cut back on 2026-01-01: max zoom 7, one color scheme, 100 req/min/IP, no satellite/nowcast. Still fine for a global radar view. |
| **NOAA GFS via NOMADS** | Raw global model (0.25°, 4 runs/day) | No | Public domain. Fallback / DIY option: we'd build our own GRIB2 → tile pipeline. More work, total control. |
| **OpenWeatherMap tile layers** (clouds, precipitation, wind, temp) | Ready-made PNG tiles | Free key | ⚠ verify current free-tier limits. Easy plug-in backup. |
| **aviationweather.gov API** | METARs/TAFs at airports | No | Public domain. Nice pairing with the flight layer. |

Plan: Open-Meteo for overlays + click forecasts, our own wind particles, RainViewer for radar.

---

## 3. Radiation

| Source | What | Key? | Notes |
|---|---|---|---|
| **Safecast** `api.safecast.org` | 200M+ crowd-sourced measurements worldwide, plus fixed sensors; nightly full CSV | No | **CC0 public domain.** Best global open source. |
| **BfS ODL (Germany)** | ~1,700 official gamma dose-rate stations, hourly | No | Open WFS/GeoJSON from BfS geoserver. ⚠ verify exact endpoint. |
| **EURDEP (EU JRC)** | ~5,000 official stations across Europe, hourly | — | Public *map*, but full data access is restricted to participating countries. ⚠ verify if any public JSON is usable. |
| **uRADMonitor** | Global network of hobby/pro sensors | ⚠ | Old docs list `data.uradmonitor.com/api/v1/devices`; reports say login now required. |
| **US EPA RadNet** | US official stations | No | ⚠ verify machine-readable access (mostly download/CSV). |

Plan: Safecast heatmap + BfS stations first; add others if access checks out.
Built: BfS + STUK/FMI + Safecast live sensors, plus the Safecast survey tiles (see step 6 below).

---

## 4. Ships / boats (AIS)

| Source | What | Key? | Notes |
|---|---|---|---|
| **aisstream.io** `wss://stream.aisstream.io/v0/stream` | Real-time global AIS over WebSocket, filter by bounding box / MMSI / message type | Free key | WebSocket only, JSON. ⚠ verify: I believe they don't allow direct browser connections → our backend subscribes and relays. Terrestrial receivers only, so open-ocean coverage is thin. |
| **Global Fishing Watch API** | Fishing activity, vessel identity, historical tracks | Free token (non-commercial) | Good for a "fishing pressure" layer and history. |

Plan: backend holds one aisstream connection for the world (or current viewport), keeps latest position per ship in memory, frontend polls/streams from us. Ship icons colored by type (cargo, tanker, passenger, fishing…).

---

## 5. Flights (real-time, 3D planes, route lines)

| Source | What | Key? | Notes |
|---|---|---|---|
| **adsb.lol** `api.adsb.lol/v2/...` | Live ADS-B, ADSBExchange-compatible JSON (by point+radius, callsign, hex, military `/v2/mil`, etc.); has a "routeset" endpoint for origin/destination | No (for now) | **ODbL open data** + free historical archive (`globe_history`). They say a feeder key will be required "in the future" — we could feed them with our own antenna later. Top pick. |
| **airplanes.live** `api.airplanes.live/v2/` | Same format | No | Non-commercial, **1 req/sec**, no SLA. Good backup. |
| **OpenSky Network** REST `/states/all`, `/tracks` | Live states + flight track (for the route line) | OAuth2 client credentials (free account) | Basic auth is gone; 4,000 credits/day for registered users, anonymous is heavily limited. Research-friendly, non-commercial. |
| **adsbdb.com** `api.adsbdb.com/v0/callsign/{CALLSIGN}` | Callsign → origin/destination airports, aircraft & airline info | No | Data may not be copied into other databases → look up live, don't store. |
| **OurAirports** CSV | Airport locations/names | No | Public domain. Needed to draw origin→destination arcs. |

**3D planes:** small low-poly glTF models (one per class: jet, turboprop, heli, military) drawn with deck.gl `ScenegraphLayer`, rotated by heading, scaled by zoom, tinted by theme. Route line = trail we accumulate from live positions (or OpenSky `/tracks`) + a dashed great-circle arc to the destination.

**About "air traffic control data":** what's openly available is **ADS-B** (what planes broadcast: position, altitude, speed, squawk, callsign). Real ATC systems (e.g. FAA SWIM) need formal agreements. ATC *voice* audio (LiveATC) is ⚠ not freely embeddable — would need permission. Emergency squawks (7500/7600/7700) are in ADS-B, so we can highlight those.

---

## 6. Webcams

| Source | What | Key? | Notes |
|---|---|---|---|
| **Windy Webcams API v3** `api.windy.com/webcams` | ~60k+ public webcams, location, preview images, embeddable timelapse player | Free key | Free tier rules: must embed their player or link images back to Windy; image URLs expire (10–15 min, ⚠ docs disagree); attribution "Webcams provided by windy.com"; offset cap on listing. Fine for us — click marker → embed player. |
| **Curated YouTube live streams** | Famous spots (Niagara, Times Square, ports, volcanoes…) | No | Only streams whose owner allows embedding. We keep a hand-maintained JSON list with coordinates. |
| **State/national traffic cams (511 systems)** | Highway cams, often public domain | Varies | Good regional extras later. |

---

## 7. Satellites

| Source | What | Key? | Notes |
|---|---|---|---|
| **CelesTrak GP** `celestrak.org/NORAD/elements/gp.php?GROUP=...&FORMAT=json` | Orbital elements (OMM JSON) for groups: `stations`, `starlink`, `gps-ops`, `weather`, `active`, etc. | No | Free; they ask you to cache — fetch each group a few times a day max. Backend caches. |
| **satellite.js** | Propagate positions + ground tracks in the browser | — | ⚠ verify OMM-JSON → satrec path (TLE definitely works; CelesTrak also serves TLE). |
| **Space-Track.org** | Authoritative source behind CelesTrak | Free account | Only if CelesTrak isn't enough. |

Features: live dots + orbit lines, ISS highlighted with footprint, "what's overhead me right now", Starlink trains.

---

## 8. Sun, space weather & sky events

| Source | What | Key? | Notes |
|---|---|---|---|
| **NOAA SWPC JSON** `services.swpc.noaa.gov/json/ovation_aurora_latest.json` (+ Kp index, solar wind, alerts) | Aurora probability grid for the whole planet, 30–90 min forecast, ~5 min updates | No | Public domain. ⚠ verify exact path. **This grid drives the simulated aurora layer** — we render animated green/purple curtains (WebGL shader) shaped and brightened by the real probability values. |
| **NASA DONKI** (`api.nasa.gov`) | Solar flares, CMEs, geomagnetic storms | Free key (`DEMO_KEY` to test) | Event cards + feeds the event DB. |
| **NASA/JPL CNEOS Fireball API** `ssd-api.jpl.nasa.gov/fireball.api` | Bright meteors/bolides detected from space, with location & energy | No | Real geolocated "meteor hit" markers. |
| **IMO meteor shower calendar** | Peak dates, radiants, ZHR | — | No API → we keep a yearly JSON (small, easy). |
| **astronomy-engine** (local) | Day/night terminator, moon phase, eclipse paths, sun/moon rise | — | Computed in browser, no API. |

---

## 9. Global events (news, disasters, conflict) + "back in time"

### Live/near-live sources
| Source | What | Key? | Notes |
|---|---|---|---|
| **GDELT 2.0** — GEO API (map of any keyword, GeoJSON, rolling 7 days), DOC API (article search, 65 languages, has preview images), **Events export** (15-min CSV with lat/lon, actors, event type, source URL) | Global news, auto-geocoded, back to 2015 (v2) | No | Free. The 15-min export is ideal for **backend ingestion** into our DB. Noisy — needs filtering/clustering. ⚠ verify API limits (DOC max 250 records). |
| **ReliefWeb API** (UN OCHA) | Curated disasters & humanitarian crises with reports | No (needs `appname` param) | High-quality summaries. |
| **GDACS** | Earthquakes, cyclones, floods, volcanoes, droughts with alert levels | No | ⚠ verify GeoJSON endpoint (RSS is certain). |
| **NASA EONET v3** `eonet.gsfc.nasa.gov/api/v3/events/geojson` | Wildfires, storms, volcanoes, floods, icebergs | No | Filters by category, date range, bbox; `status=all` gives history. |
| **USGS earthquakes** `earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson` + FDSN query API | Live & historical quakes | No | Public domain. |
| **NASA FIRMS** | Active fire hotspots from satellite | Free MAP_KEY | Great visual layer. |
| **ACLED** | Curated conflict events (protests, riots, battles) | Free registration | Best quality for wars/riots, but terms restrict redistribution & require attribution. Fine for personal use; ⚠ read terms before showing publicly. |
| **Wikipedia "Current events" portal / Wikimedia API** | Human-written daily summaries + Commons images | No | CC BY-SA. Good source for the explanation text + images on a marker. |

### How the "!" markers would work
1. Ingest workers pull the sources above on a schedule into our DB.
2. Group duplicates (same place + time + topic) into one **event**: title, category (unrest / war / disaster / space / …), severity, location (point or area), start/end time, summary, image, source links.
3. Optional: use an LLM (Claude API) to merge a cluster of headlines into a short neutral explanation for the marker popup. Not required to start.
4. Frontend marker icon by category, popup with summary, image, sources.

### "Back in time"
- DB stores every event with `start_time`/`end_time` → a **timeline slider** queries `/events?at=2026-06-01` (or a range).
- Can backfill history: GDELT (2015+), USGS (decades), EONET (`status=all`), DONKI, CNEOS.
- Some layers can time-travel natively: GIBS imagery (date in URL), adsb.lol `globe_history` archives.
- Live layers (planes/ships) we do **not** archive at first — too much data. Maybe snapshots later.

---

## 10. Future: SDR

| Source | What | Notes |
|---|---|---|
| **KiwiSDR public list** — `rx.linkfanel.net/kiwisdr_com.js` (JSON array: name, url, loc/GPS, antenna, users, bands, offline…) | Hundreds of public HF receivers worldwide | ⚠ verify current format. Plot each at its real location; click opens its web UI. |
| **WebSDR.org** list | Classic WebSDRs (e.g. Twente) | No API → scrape the list page. |
| **OpenWebRX receiver map** (receiverbook.de) | Public OpenWebRX stations | ⚠ verify a machine-readable list exists. |
| **Your own station** | Always-on antenna | Run **OpenWebRX+** (or a KiwiSDR) on the station, expose through the website's reverse proxy, put it on the map with a special marker. Same receiver could also feed ADS-B/AIS to adsb.lol and our own map. |

"One-click listen": open the receiver's own UI in a panel/iframe (⚠ some may block iframes → new tab fallback).

---

**Next features:** search, flags, lidar, UFOs, webcams, Radio, Shodan and WiGLE are researched in [next-features-plan.md](next-features-plan.md).

## 11. Suggested build order

1. ✅ **Skeleton** (done 2026-11-03) — Node server, MapLibre map, Streets / Satellite / Daily (NASA) base maps, globe toggle, 4 themes with effects. See README.
2. ✅ **Flights** (done 2026-11-03) — 3D planes, smooth motion, trail + route, click panel. Findings while building:
   - adsb.lol has **no CORS headers** and no "all aircraft" endpoint (point queries ≤ 250 nm only), and it does rate-limit (HTTP 429) under bursts → server proxies, caches, and falls back to airplanes.live.
   - adsb.lol's `routeset` endpoint now returns nothing; the data behind it (adsb.im) requires prior approval. Using **adsbdb** `/v0/callsign/{cs}` (no key) for routes and `/v0/aircraft/{hex}` for type, owner and a photo URL.
   - Flight path: `https://adsb.lol/data/traces/{last2hex}/trace_full_{hex}.json` (gzip body, ~24 h of points; we cut it to the current leg).
   - OpenSky anonymous: 400 credits/day, global `/states/all` costs 4 → ~100 calls/day.
   - planespotters.net photo API requires a contact URL/email in the User-Agent; skipped for now.
3. ✅ **Weather** (done 2026-11-03) — 11 Open-Meteo overlays, timeline + play, legend, cursor value, click forecast, GFS wind particles. Findings:
   - `@openmeteo/weather-map-layer` is GPL-2.0, "not yet fully production-ready"; pinned 0.3.0. URL params: `time_step=valid_times_N` / `current_time_1H`, `dark=true`. Exposes `getColorScale` and `getValueFromLatLong`.
   - Without cross-origin isolation it took ~10 s for the first overlay; with COOP + COEP `credentialless` ~1.5 s.
   - NOAA retired the NOMADS OPeNDAP (`/dods/`) text service; the GRIB filter (`filter_gfs_1p00.pl`) still works. GFS 1° wind is GRIB2 template 5.3 (complex packing + spatial differencing), decoded in-house.
   - RainViewer radar not added yet (free tier now max zoom 7); ECMWF precipitation covers the global view.
4. ✅ **Satellites + space weather** (done 2026-11-03) — 17k satellites in 3D, orbit/footprint panel, night + terminator, animated aurora, Kp/solar wind card. Findings:
   - CelesTrak answers repeat downloads (same data within ~2 h) with the text "GP data has not updated since your last successful download" → disk cache.
   - 950+ active objects already have catalog numbers above 99999, which the classic TLE format can't hold → use OMM JSON + satellite.js 7 `json2satrec`.
   - satellite.js 7's package index pulls in a WASM bulk propagator; the worker imports `io.js`, `propagation.js`, `transforms.js` directly instead.
   - On a cross-origin-isolated page, worker scripts must also be served with COEP, or they silently fail to start.
   - deck.gl on MapLibre's globe: TextLayer needs `parameters: { cullMode: 'none' }` or labels vanish; points behind the Earth draw on top of it (we hide them with an occlusion test).
   - SWPC `products/solar-wind/*.json` now 404; using `json/rtsw/rtsw_wind_1m.json` and `rtsw_mag_1m.json` (mixed spacecraft, newest first, `active` flag).
5. ✅ **World events** (done 2026-11-04). Part 1: disasters (USGS, GDACS, EONET) in a rolling SQLite store, with markers, panel, filters and time ranges. Part 2: news from Wikipedia Current events, plus GDELT related coverage in the panel. Decisions and findings:
   - **Wikipedia Current events** wikitext:
     - Format: `'''Section'''` lines, then nested `*` bullets. Bullets made only of links are topics ("Gaza war"); the others are one-sentence news items with `[url (Outlet)]` citations.
     - One event per deepest topic, which collects its daily updates. Untopiced items stand alone.
     - Placement: the most specific linked article with coordinates. Town beats region beats country, judged from the short description.
   - **Wikimedia rate limits** (Nov 2026):
     - `api.php` answers anonymous bursts with 429 (envoy, `retry-after: 2`), and stays throttled for 10+ minutes after repeated bursts. REST `page/summary` is also limited for pages not in the CDN cache.
     - `index.php?action=raw` (cached) is fine.
     - What we do: raw day pages 1/s; coordinates via `api.php` batched 50 titles per query at 1 per 3 s; results cached on disk for 14 days. Optional `WIKIMEDIA_CONTACT` goes in the User-Agent for better limits, as Wikimedia's UA policy asks.
   - **GDELT DOC API:** often returns 429 "one request every 5 seconds" even when spaced out. Used only on demand for "Related coverage" (throttled 6 s, cached 1 h, failures hidden). The GEO 2.0 endpoint returns 404.
   - **Not an archive** (your call): the store keeps a rolling window, 30 days by default (`EVENTS_RETENTION_DAYS`), pruned every 6 h. No historical backfill. "Back in time" means the 24 h / 3 d / 7 d / 30 d range buttons.
   - SQLite comes from Node's built-in `node:sqlite` (Node 22.5+, no warning on Node 24), so there are still zero npm dependencies. File: `data/events.sqlite`.
   - GDACS:
     - `geteventlist/MAP` now needs an event type. Two endpoints together cover what we need:
       - `EVENTS4APP`: current events at all levels, capped at 100, mostly green wildfires.
       - `SEARCH`: defaults to Orange/Red; takes `fromdate`/`todate`.
     - `polygons/getgeometry` gives cyclone tracks (`Line_*`) and wind zones (`Poly_Green/Orange/Red`). It's about 0.5 MB raw; the server slims it to about 40 KB.
     - GDACS rates cyclones by people at risk, so a 240 km/h typhoon over open sea is "Green". We bump storms at 178 km/h or more (Cat 3+) to significant.
   - Earthquakes come from USGS only (M5+), not GDACS too, to avoid duplicates.
   - EONET: volcanoes, plus wildfires of 5,000 acres or more. Its wildfire feed is mostly US prescribed burns, which are skipped.
   - deck.gl interleaved layers only draw when MapLibre renders a frame, so `overlay.set` now requests a repaint. Without it, layers that don't move (like event shapes) waited until the map moved.
6. **Ships and radiation** ✅ done (webcams moved to the next batch, after more research). Findings:
   - **Layer list order** is now: Weather, Night/Sun/aurora, Radiation, Flights, Ships, Satellites, World events, Webcams, Radio.
   - **Digitraffic** (`meri.digitraffic.fi/api/ais/v1/locations` + `/vessels`): open, no key, ~950 ships around Finland/the Baltic. Positions can be hours old for ships that left receiver range, so moving ships older than 30 min are dropped. ETA is bit-packed (month/day/hour/minute).
   - **aisstream.io**: free key needs an account (GitHub sign-in), which the owner has to create. Subscription message must arrive within 3 s; the key must stay server-side. No published quota. Coded but untested until a key is added.
   - **Kystverket (Norway) raw AIS** `153.44.253.27:5631`: no connection from here (timed out). Skipped.
   - **BfS ODL** WFS works: `opendata:odlinfo_odl_1h_latest` (~1,670 stations, ~1,550 in operation) and `odlinfo_timeseries_odl_1h` with `CQL_FILTER=kenn='…'` for history. Its GeoServer sometimes answers with an XML "connection pool" error for minutes at a time; retried once, then shown as unavailable.
   - **STUK** via FMI WFS stored queries `stuk::observations::external-radiation::latest::multipointcoverage` (247 stations, µSv/h, 10-min) and `…::multipointcoverage` with `fmisid` + `timestep=60`, max 168 h per request. CC BY 4.0.
   - **Safecast realtime** `tt.safecast.org/devices`: ~2,100 devices, ~150 reported in the last day. LND 7318 fields are CPM (÷334), LND 7128ec CPM (÷108); `lnd_712u` values look like µSv/h on some devices and are skipped.
   - **Safecast survey tiles** `s3.amazonaws.com/te512.safecast.org/{z}/{x}/{y}.png` (512 px, z0–16) have no CORS header, so they go through our server.
   - **EURDEP**: data may not be reused without each provider's written consent. Skipped. **US EPA RadNet**: only a Qlik dashboard and CSV/CDX downloads, no live API found. **uRADMonitor**: API now needs login.
7. **Meteors, fires, extra disasters**.
8. **Hosting** on your site (+ Postgres/PostGIS).
9. **SDR** layer + your station.

## Open questions for you
- ~~Backend language~~ → decided: **Node.js** (installed locally, see section 0).
- Globe view by default, or flat map with an optional globe toggle?
- Public site eventually, or just for you? (Changes which licenses are OK — ACLED, Sentinel-2 NC, Open-Meteo non-commercial.)
