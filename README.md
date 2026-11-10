# WorldScope

A themeable live world map: weather, flights, ships, satellites, space weather,
world events and more. Data sources and the full plan are in
[docs/data-sources.md](docs/data-sources.md).

## Run it locally

Needs Node.js 22.5+ for the built-in SQLite. No `npm install` is needed; there are no dependencies.

```bash
npm start
```

Then open http://localhost:3000. Use `npm run dev` instead to auto-restart the
server when server files change. Frontend files are served fresh on every
reload, so just refresh the browser after editing them.

Don't open `public/index.html` directly from disk: browsers block ES modules
and many API calls on `file://`. Always go through the server.

## Secrets

Every API key lives in **one file: `secrets/secrets.env`** (`KEY=value` lines).
The whole `secrets/` folder is gitignored except the template
`secrets/secrets.example.env`, which lists every key the app understands. To
deploy, copy `secrets/secrets.env` to the same place on the server. All keys are
optional; the app runs without them.

## Layout

```
server/server.js            Node server: serves /public and routes /api/*
server/lib/cache.js         In-memory cache (shared upstream calls, stale-on-error) + throttle
server/lib/http.js          fetchJson with timeout, user agent, gzip handling
server/sources/flights.js   Flight data: live, world snapshot, trace, route, aircraft details
server/sources/weather.js   GFS wind grid (for particles) + Open-Meteo point forecast
server/lib/grib2.js         Small GRIB2 decoder for NOAA GFS files (no dependencies)
server/sources/space.js     Satellite catalog (CelesTrak), aurora grid + space weather (NOAA SWPC)
server/sources/ships.js     Ships: Digitraffic poll + aisstream.io WebSocket, latest position per MMSI in memory
server/sources/radiation.js Radiation stations (BfS, STUK/FMI, Safecast), station history, Safecast tile pass-through
server/sources/radio.js     Radio: SDR receivers (Receiverbook + KiwiSDR list), Radio Browser stations, WSPR paths
server/sources/webcams.js   Webcams: Windy by map cell, Digitraffic and Caltrans road cameras
server/sources/outages.js   Internet outages: IODA country events and signal history
server/sources/launches.js  Rocket launches: Launch Library 2, kept on disk
server/sources/emergencies.js  What's urgent now, across the other sources
server/sources/tour.js      Stops for tour mode
server/sources/countries.js Country summaries and live counts (events, flights, ships, radiation)
server/sources/search.js    Search: countries, cities, Photon places, and everything live on the map
server/geo/cities.json      Towns over 15,000 people, for search (built by scripts/build-geo.mjs)
server/sources/events/      World events: store.js (SQLite, rolling window), index.js (scheduler + API),
                            one ingester per source (usgs.js, gdacs.js, eonet.js, wikipedia.js),
                            gdelt.js (related coverage for the panel)
data/cache/                 On-disk API cache (gitignored), e.g. the CelesTrak catalog
data/events.sqlite          World events store (gitignored), a few MB at most
secrets/                    secrets.env (gitignored) + secrets.example.env template
public/index.html           Page shell
public/css/themes.css       UI theme variables (colors, fonts, effect colors)
public/css/app.css          Layout and components
public/js/main.js           Boot + UI wiring (themes, base maps, layer toggles, status bar, opening things)
public/js/search.js         Search box: grouped results, keyboard control, coordinates
public/js/share.js          Reads and writes the view in the page address
public/js/cluster.js        Groups points that would overlap at a zoom level
public/js/badges.js         Map badges: sprites, count pills and the layer list icons
public/geo/countries.json   Country shapes and facts (built by scripts/build-geo.mjs)
public/flags/               Country flags as SVG (flag-icons, MIT)
public/js/map.js            MapLibre map: recolors the OpenFreeMap style per theme, adds imagery
public/js/themes.js         Map side of each theme (vector palette, satellite tint, sky, effect, plane colors)
public/js/effects.js        Full-screen canvas effects (matrix rain, embers, gold dust)
public/js/overlay.js        One shared deck.gl overlay; each data layer registers its layers here
public/js/geo.js            Distance, great circles, dead reckoning, color helpers
public/js/models/airplane.js  Low-poly 3D airliner generated in code
public/js/layers/flights.js   Flights layer (fetching, smooth motion, selection, trail, route)
public/js/layers/flight-panel.js  Selected-aircraft side panel
public/js/layers/weather.js       Weather overlays, timeline, legend, cursor value, click forecast
public/js/layers/wind-particles.js  Animated wind flow canvas
public/js/layers/forecast-popup.js  Forecast popup HTML (weather codes, 24 h chart, 7 days)
public/js/layers/satellites.js    Satellites: points at true altitude, orbit, ground track, footprint, panel
public/js/workers/sat-worker.js   SGP4 orbit propagation for ~17k satellites (satellite.js)
public/js/layers/space-weather.js Night shading + terminator, Sun, animated aurora, space weather card
public/js/layers/events.js        World events: markers, filters, time range, details panel, cyclone tracks
public/js/layers/ships.js         Ships: hull icons by type, type filters, details panel, recent track
public/js/layers/radiation.js     Radiation: stations on a fixed dose-rate scale, week chart, Safecast survey map
public/js/layers/radio.js         Radio: receivers, station player, shortwave paths with band filter
public/js/layers/webcams.js       Webcams: badges by view, Windy player, refreshing road camera images
public/js/layers/outages.js       Internet outages: country badges, signal charts
public/js/layers/launches.js      Rocket launches: pad badges, countdowns
public/js/layers/emergencies.js   Emergencies strip under the top bar
public/js/tour.js                 Tour mode
public/js/layers/countries.js     Countries: flag tiles drawn in the browser, country panel, flag controls
scripts/build-geo.mjs       Rebuilds the country and city files; run by hand
docs/data-sources.md        Research: where every layer's data comes from
docs/next-features-plan.md  What's next, what's skipped, and why
docs/server-impact.md       CPU, memory, disk and network use, and the sleep mode idea
```

## Flights

- **Zoomed in** (view radius ≤ 250 nm): live ADS-B every 5 s from adsb.lol,
  falling back to airplanes.live if adsb.lol rate-limits us (that fallback currently answers 403).
- **Zoomed out**: OpenSky's global snapshot (~10k aircraft). Anonymous access
  allows ~100 calls/day, so the server caches it for 15 min; add OpenSky API
  client credentials to `secrets/secrets.env` to refresh every 90 s. Between updates every plane
  is dead-reckoned along its track at its ground speed, so motion stays smooth.
- Planes are colored by altitude (theme colors); military, emergency squawks
  (7500/7600/7700) and planes on the ground get their own colors.
- **Click a plane**: side panel with callsign, airline, route + progress, altitude,
  speed, heading, vertical rate, type, registration, squawk and a photo when
  available. The solid line is the path flown this leg (adsb.lol trace); the
  dashed line is the great-circle route ahead to the destination (adsbdb).
  Routes come from a crowd database and can be outdated; the panel warns when
  the listed route doesn't fit where the plane actually is. **Follow** keeps the
  map centered on it.

## Base maps

- **Streets**: OpenFreeMap vector tiles (OpenStreetMap data), recolored per theme.
- **Satellite**: Esri World Imagery, with theme tinting.
- **Daily**: NASA GIBS VIIRS true-color mosaic for a chosen date (defaults to
  yesterday UTC). Uses NOAA-20 from 2018 on, Suomi NPP before that.
- **Globe** toggle switches between 3D globe and flat Mercator.

## Weather

- **Overlays**: temperature, rain, clouds, wind, gusts, pressure, thunderstorm
  energy (CAPE), humidity, fog/visibility, snow depth, sea temperature. ECMWF IFS
  data (~9 km) rendered in the browser by Open-Meteo's
  [`@openmeteo/weather-map-layer`](https://github.com/open-meteo/weather-map-layer)
  straight from their public S3 bucket.
- **Timeline**: every hour of the latest model run (~15 days), with play/pause.
- **Wind flow**: animated particles driven by NOAA GFS 10 m wind (1° grid). The
  server pulls it from NOMADS as GRIB2 and decodes it (`server/lib/grib2.js`).
  It follows the timeline in 3-hour steps.
- **Cursor readout**: the overlay's value under the mouse shows in the status bar.
- **Click anywhere**: forecast popup (now, next 24 h chart, 7 days) from Open-Meteo.
- The server sends cross-origin isolation headers (COOP/COEP `credentialless`) so
  the weather layer can share data with its workers; that made overlays load
  ~5× faster in testing.
- Licensing: the weather-map-layer library is **GPL-2.0** and Open-Meteo data is
  CC BY 4.0, free for non-commercial use. Fine for a personal site; revisit if
  the site ever goes commercial.

## Satellites

- Every active object in CelesTrak's catalog (~17k), drawn at its real altitude:
  the Starlink shell hugs the globe, navigation satellites sit ~20,000 km out,
  the geostationary ring ~36,000 km out. Zoom out on the globe to see it.
- Categories (toggle under the Satellites row): space stations (ISS and
  Tiangong labeled), broadband constellations, navigation, weather,
  geostationary, everything else.
- Orbits are computed in the browser with SGP4 (satellite.js) in a Web Worker,
  once a second, and interpolated in between.
- **Click a satellite**: its full orbit (solid), ground track (dashed), the area
  of Earth that can see it, and a panel with altitude, speed, period,
  inclination, launch year. **Follow** tracks it.
- CelesTrak refuses repeat downloads within ~2 h, so the server caches the
  catalog on disk (`data/cache/`, 6 h) and serves the saved copy if a refresh fails.

## Night, Sun & aurora

- Night shading with twilight fading out to −18° sun elevation, a gold
  terminator line where the Sun is on the horizon, and a Sun marker at the
  subsolar point. Recomputed every minute.
- **Aurora**: NOAA SWPC's OVATION forecast (probability of aurora, 30-90 min
  ahead, refreshed every 10 min) sets where it is and how bright. The moving
  curtains, rays and color (violet edges, oxygen green, whitish cores) are a
  simulation layered on that real shape.
- Status card under the layer: Kp index (with storm level), solar wind speed,
  Bz, NOAA G/S/R scales, how far toward the equator aurora reaches, latest alerts.

## World events

This layer shows what's happening now; it isn't a history archive. The server
polls each source on its own schedule into `data/events.sqlite` and deletes
anything that ended more than `EVENTS_RETENTION_DAYS` ago (default 30, set in
`secrets/secrets.env`). Browsers only read from that store.

- **News** comes from Wikipedia's
  [Current events](https://en.wikipedia.org/wiki/Portal:Current_events) portal,
  checked every 30 min:
  - **What it is:** a daily list of major stories written by people, sorted
    into armed conflicts, politics, disasters, law and crime, etc. Each story
    cites outlets like AP, Reuters and the BBC.
  - **Topics:** each topic (e.g. "Gaza war") becomes one marker that collects
    its daily updates.
  - **Placement:** the marker goes to the most specific linked place that has
    coordinates (a town beats a region beats a country), so positions are
    approximate.
  - **Kinds:** war & attacks, protests & unrest (detected from the wording),
    politics, accidents, law & crime, other news.
  - **Severity:** raised by reported deaths, coups and similar.
  - **No duplicates:** news about natural disasters near a USGS/GDACS event is
    dropped, since that event is already on the map.
- **Natural hazards** (no keys needed):
  - USGS: earthquakes of magnitude 5+, every 5 min.
  - GDACS: cyclones, floods, volcanoes, droughts and wildfires with UN/EU alert levels, every 15 min.
  - NASA EONET: volcanoes and large wildfires, every 30 min.
- **Severity:** major (red), significant (amber), minor (grey). Minor events
  (every M5 quake, small fires, sports and business news) stay hidden unless
  "Include minor events" is ticked.
- **Time range:** 24 h, 3 d, 7 d or 30 d. Events from the last 6 hours pulse.
- **Click a marker:** a panel shows:
  - what, where, when and status
  - magnitude, wind or alert level for hazards
  - for news, a photo and a day-by-day list of updates with links to the
    outlets that reported them
  - "Related coverage": recent articles with preview images, matched
    automatically by GDELT (best-effort, since GDELT often refuses requests)

  Cyclones also show their track (dashed) and wind zones. **Zoom to** fits the
  map to the event.
- **Wikipedia rate limits:** Wikipedia limits anonymous clients hard. The
  server spaces its requests out and caches article lookups in
  `data/cache/wiki-articles.json`. Setting `WIKIMEDIA_CONTACT` (your site URL)
  in `secrets/secrets.env` gets much better limits, as Wikimedia's
  User-Agent policy asks.
- **First start:** reading the 30-day window takes a few minutes on the first
  run; after that only the last 3 days are re-read.
- **Adding a source:** write a module in `server/sources/events/` that exports
  `{ id, name, everyMs, fetch }` and returns normalized events, then list it in `index.js`.

## Radiation

Latest ambient gamma dose rate, in µSv/h, from about 1,950 stations. Data is
fetched when someone has the layer on and cached in memory; nothing is stored.

- **Sources (no keys):**
  - BfS (Germany): ~1,550 official stations, hourly.
  - STUK via the Finnish Meteorological Institute: ~250 official stations, every 10 min.
  - Safecast: ~150 live volunteer sensors worldwide (white ring on the map). They
    report counts per minute; the dose rate uses Safecast's factor per tube.
- **Colors** are the same in every theme because they carry meaning: low, normal,
  elevated, high, very high, extreme. Natural background is usually 0.05–0.3 µSv/h.
- **Click a station:** reading, level, when it was measured, the split between
  ground and cosmic radiation (BfS) and a 7-day hourly chart for official stations.
- **Safecast survey map** (off by default): Safecast's own map of everything its
  volunteers have logged, mostly from drives; strongest in Japan. Not live. Served
  through `/tiles/safecast/` because their tile bucket has no CORS headers.
- **A slow source doesn't hold up the rest:** each gets 12 s; a missing one is
  shown as unavailable and retried a minute later.

## Ships

Ship positions from AIS, kept in memory only (latest position per ship plus a
short track). Moving ships whose last report is over 30 min old are left off;
moored and anchored ones stay up to 3 h.

- **Digitraffic** (Finland, no key): every ship its coastal receivers hear around
  the Baltic, polled each minute; names and types every 15 min.
- **aisstream.io** (worldwide, free key): set `AISSTREAM_API_KEY` in
  `secrets/secrets.env`. The server holds one worldwide WebSocket and shares
  it with every viewer (about 100 messages/s, 0.5 Mbit/s). Coverage is coastal
  receivers only: strong around Europe and North America, thin across Asia and
  the open ocean. Ship types arrive in slower reports, so many show as "other"
  for a while after a restart or a sleep.
- **Map:** hull arrows pointing where the ship is heading, colored by type (cargo,
  tankers, passenger, fishing, tugs/pilots/official, sailing/pleasure, other).
  Moored and anchored ships are small dots and can be hidden.
- **Click a ship:** name, type, status, speed, heading, destination, ETA, size,
  draught, call sign, IMO, MMSI, its recent track, Follow, and a MarineTraffic link.
- **Big views** send at most 20,000 ships (moving commercial traffic first).
- **Sleep mode:** both feeds stop 10 minutes after the last viewer and restart on the
  next visit, so the map is thin for a while after waking. Open pages report in
  every minute while visible. Details are in [server impact](docs/server-impact.md).

## Radio

Three parts, each with its own switch under Radio in the layer list. Nothing loads
until the layer is on.

Receivers are round badges with a radio mast, in their type's color, and stations are
pink with a music note. Those that would overlap join into a count badge, with
receivers and stations counted apart. Click it to zoom in. If its contents share a spot, as many of
a city's stations do, it lists them instead.

- **SDR receivers** (about 1,770 sites): real radios run by volunteers, faded when full. Click for the receivers at that site, with listeners,
  bands and antenna where known, and open one in a new tab to tune it. The list merges
  Receiverbook with the KiwiSDR list. Receiverbook has no API, so its list is read from
  a script in its map page once a day, and a redesign of that page would break it. The
  KiwiSDR list keeps the layer working if that happens.
- **Internet radio** (about 12,800 stations): the Radio Browser stations with a
  position and a working stream. Click to play; it keeps playing while you explore, and
  a small player in the layer list stops it. HLS streams are left out because they need
  a player library. Once the site is on HTTPS, browsers will refuse plain HTTP streams
  inside the page (about 1 in 5), so those show a link instead.
- **Shortwave paths**: low-power WSPR beacons heard in the last 15 minutes, from
  wspr.live. Colored by band, each band can be switched off, and hovering shows who
  heard whom. It's a stable sample of 5,000 paths out of about 60,000 and refreshes
  every 3 minutes. They're arcs above the globe and lie flat once zoomed in.

## Webcams

Every camera is a badge with a camera inside: blue for Windy, amber for road cameras.
Cameras that would overlap join into a badge with a count, colored by whichever kind
is in the majority. Click it to zoom in. The count covers the cameras loaded for this
view, so a Windy-heavy area can hold more than it shows.

- **Windy** (`WINDY_WEBCAMS_API_KEY`): about 69,000 cameras. The free tier only lists
  the first 1,000 of any search, so the world is split into cells that get smaller as
  you zoom in, and each cell loads its 50 most viewed cameras. Cells stay in memory for
  a day, and a closer view shows more. Windy limits how fast we can ask, so new cells load
  about two a second: a view shows what's ready and fills in over the next few seconds.
  If Windy still says it's too fast, the server waits as long as it asks and the page
  tries again. Click for Windy's own player: their terms limit
  what can be done with the images, so we don't show or store them. Positions and titles
  are all we keep.
- **Road cameras** (no key): Digitraffic in Finland and Caltrans in California, about
  4,250 together. These are still images straight from the source, refreshed every
  minute while the panel is open. The list is cached on disk for 6 hours.
- **Browsers:** the page is cross-origin isolated, so the player uses a Chromium feature
  (`credentialless` iframes). Other browsers may block it, so Open on Windy is always there.

## Internet outages

Countries IODA (Georgia Tech) flagged in the last 48 hours: a red badge while it's
happening, amber once it's over. Click one for when it started, how long it lasted, and a
chart of each signal over the two days.

Three filters keep the map honest, all found by looking at live data:
- Google traffic alerts don't count alone. They ran for days with nothing wrong, such as
  a five-day "outage" in Finland.
- Drops over 7 days are left out. Those are the normal level moving, as when a network
  renumbers.
- Ended drops under 30 minutes are left out as measurement noise.

A drop can still mean a network changed its routes rather than people losing access, and
the panel says so. Countries only: an outage in one city usually won't show.

## Rocket launches

From Launch Library 2: 40 upcoming launches and the last 14 days, on their pads. Upcoming
is yellow, the next 24 hours orange and past launches grey. Launches that would overlap
join into a count badge that zooms in when clicked, or lists them if they share a pad.

The panel has a live countdown when the time is known to the hour or better, otherwise it
says how exact the date is. The layer list counts down to the next launch. The free tier
allows about 15 requests an hour, so the list refreshes every 20 minutes while someone is
looking, and it's kept on disk through restarts.

## Emergencies

A strip under the top bar listing what's urgent now, refreshed every minute. It's on by
default, stays out of sight when there's nothing to show, and clicking a row flies there
and opens it. Hiding it lasts until something new appears.

- **Aircraft** squawking 7700, 7600 or 7500, worldwide from adsb.lol.
- **Ship beacons**: AIS-SART, man overboard and EPIRB signals, from the ships we're tracking.
- **Radiation** at 1 µSv/h or more at official stations. Volunteer sensors need 10 or more,
  because a few read high for weeks.
- **Disasters** from USGS and GDACS: earthquakes of magnitude 6.5 or more and red alerts,
  last 24 hours.
- **Internet outages** happening now.

These are automatic signals, and they can be tests or mistakes. If a check fails, the strip
says what wasn't checked rather than looking like all clear.

## Tour mode

The Tour button flies the globe between what's happening now, with a caption at each stop
and the controls hidden: emergencies first, then disasters and conflicts, launches,
outages and the space station. It's good on a wall display. Adding `tour=1` to a link
starts it on load.

Space pauses, the arrow keys skip, Esc ends it, and dragging the map pauses it. It turns
on the layers it needs and puts them back when it ends. Stops are fetched again each lap.

## Search and links

The box at the top searches countries, towns, other places, ships, flights,
satellites, launches, events, radiation stations, webcams, radio stations and SDR receivers. Press `/` to jump to it. Picking a result
flies there, turns on its layer and opens its panel. Typing `60.17, 24.94` goes to
those coordinates.

- **Places:** towns come from a local GeoNames list, so they work offline. Photon
  (OpenStreetMap) fills in the rest when the list has fewer than 5 matches. Nominatim
  isn't used because its policy forbids search-as-you-type.
- **Flights:** only text shaped like a callsign searches them, so ordinary typing
  never spends OpenSky credits.
- **Sources that aren't ready** are left out of that search and keep loading for the next.
- **Webcams:** Windy can't be searched by name, so only road cameras and Windy cameras
  already loaded for a view are found.

**Links:** the page address always describes the view: camera, layers, the selected
object, theme and base map. Copy it, or use the link button in the search box. A shared
link applies to that visit and doesn't overwrite the saved preferences until the
viewer changes something.

## Countries & flags

- **Flags:** map tiles drawn in the browser. A canvas clips each country's shape and
  draws its flag inside, so borders stay sharp and the server does nothing. Each
  separate landmass gets a whole flag, stretched to fit, up to a limit. Very small
  islands get the flag's average color. Opacity and which countries show are in the layer list.
- **Panel:** click a country with the layer on, or find it by search. It shows a
  Wikipedia summary, facts from GeoNames, and live counts worked out on the server.
  "Ships near coast" means within about 30-50 km of its outline, so neighbors overlap.
- **Borders** are Natural Earth's, showing who controls what on the ground rather than
  any official position. Three areas have no ISO code, so no flag: Somaliland, Northern
  Cyprus and Siachen Glacier.

To rebuild the data, run `node scripts/build-geo.mjs`. Sources: Natural Earth
(public domain), GeoNames (CC BY 4.0), Wikidata (CC0), flag-icons (MIT).

## Adding a theme

1. Copy a `[data-theme="..."]` block in `public/css/themes.css` and change the UI colors/fonts.
2. Add a matching entry in `public/js/themes.js` (map palette, satellite tint, sky, effect).
3. If it uses a new Google Font, add it to the fonts link in `public/index.html`.

The theme picker builds itself from `themes.js`; the choice is remembered per browser.

## Debugging

The map API is exposed as `window.worldscope` in devtools, e.g.
`worldscope.map.jumpTo({ center: [-79.07, 43.08], zoom: 13 })` or
`worldscope.features.flights.select('4ca217')`.
