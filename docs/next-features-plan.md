# WorldScope: next features plan

Research pass, 2026-11-04. The build order below shows what's done. "Tested" means we called
the source from this machine that day. Everything else comes from the source's
documentation or a web search and should be rechecked when building.

## Decisions (2026-11-04)

- The site is for fun and will never make money, so non-commercial terms are fine.
- **Shodan and WiGLE: skipped for now.** See the todo at the end.
- **UFO sightings: on pause.** Nobody offers a free API, and neither the snapshot nor
  emailing NUFORC is what's wanted. Revisit if a free feed appears.
- Windy webcam key is in `secrets/secrets.env` as `WINDY_WEBCAMS_API_KEY`.
- All the suggestions below are approved.

## Build order

| Batch | What | Status |
|---|---|---|
| A | Shareable links, search, country panel, flag overlays | **Built** (2026-11-04) |
| B | Radio layer, webcams | **Built** (2026-11-04) |
| C | Lidar | **Dropped** (2026-11-04): land lidar isn't what's wanted. See "Seafloor" below |
| D | Emergencies strip, internet outages, launches, tour mode | **Built** (2026-11-04) |
| E | Watch zones, trains, air quality | Approved; needs detailed planning |

Ship sleep mode is built; see [server impact](server-impact.md).

Later: meteors, fires, more disasters, hosting.

---

## Search

**Behaviour:** one box at the top. Results arrive in groups: Places, Countries,
Ships, Flights, Satellites, Events, Radiation stations, Webcams, Radio. Picking
one flies there, turns its layer on and opens its panel. Typing coordinates
(`60.17, 24.94`) jumps straight there. Arrow keys and Enter work.

**Places:** Photon (`photon.komoot.io`, tested). It is built for search-as-you-type
and its public server accepts reasonable use. Nominatim is ruled out: its policy
forbids autocomplete and bans clients for it, with a 1 request/second limit.

**Fallback:** GeoNames `cities15000` (tested, 3.4 MB zip, CC BY), loaded in memory
so towns and cities still work if Photon is down or throttling us.

**Server:** `GET /api/search?q=`
- Each source registers `search(q)`, which scans its in-memory data.
- Place lookups are cached and only run from 3 characters, after 250 ms of no typing.
- Every viewer shares one server-side connection to Photon, so a popular site could
  hit its fair-use limit. The next step then is self-hosting a single-region Photon
  or lowering lookups, not Nominatim. A worldwide Photon index is too big for this server.

**Client:** each layer gains `focus(id)`, which enables the layer if needed and
selects the object.

## Shareable links (part of search)

The URL hash stores camera, layers, theme and the selected object, for example
`#60.17,24.94,z6/ships,radiation/ship:230629000`. Small job, and it makes search
results, event alerts and tour mode linkable.

## Flag overlays

**Data:**
- Country shapes: Natural Earth 1:50m (tested, 3 MB GeoJSON, public domain). Join on
  `ISO_A2_EH`, since `ISO_A2` is `-99` for France, Norway and others.
- Flags: `flag-icons` 7.6.0 (MIT, about 4 MB of SVG). We copy them into the project.

**Rendering:** MapLibre can't clip one image to a polygon, and `fill-pattern` only
repeats a small image. So we generate the map tiles in the browser:
1. Register a `flags://{z}/{x}/{y}` tile protocol with `maplibre.addProtocol`.
2. For each tile, a canvas clips to the country outlines in that tile and draws
   each flag scaled to cover its landmass.
3. Add the result as a raster layer below labels and roads. The opacity slider sets
   `raster-opacity`, and it works on the globe like every other raster layer.

No server work or large files, and borders stay sharp at any zoom. Choosing
countries re-renders only the tiles that need it.

**Choices to prototype:**
- Far-flung territory such as Alaska or French Guiana: each sizeable landmass gets
  its own whole flag, otherwise Alaska would show a stretched corner of the US flag.
- Non-rectangular flags (Nepal) get a neutral background.

**Controls:** All on or off, opacity slider, pick countries from a list or by clicking.

**Caveat:** Natural Earth draws de facto borders, and some disputed areas (Somaliland,
Northern Cyprus) have no ISO code. A small note in the layer states this.

## Country panel (my addition, built with flags)

Clicking a country opens one panel: flag, Wikipedia summary, population, local time,
then live counts from our own layers (events, ships, flights overhead, radiation
level, internet outages). The shapes are loaded anyway for flags, and this turns
separate layers into one answer to "what's happening in this country?".

---

## Radio layer

Built; see the README for how it ended up. Found while building: only 12,843 of Radio
Browser's stations have a position and a non-HLS stream, and the KiwiSDR list file has a
trailing comma, so it needs repairing before parsing.

Three sub-layers under the renamed Radio entry.

**SDR receivers** (tested):
- Receiverbook `/map`: 1,248 sites (736 KiwiSDR, 430 OpenWebRX, 100 WebSDR), read from
  a JSON list embedded in the page. There is no API (`/api/receivers` is a 404), so
  this breaks if they change the page. We read it once a day.
- KiwiSDR list via `rx.linkfanel.net/kiwisdr_com.js`: 844 online, with GPS position,
  antenna, current users and capacity, SNR. It adds live detail. `kiwisdr.com` itself
  couldn't be reached from here.
- Merged by URL. Dots colored by type, dimmed when full. The panel shows bands,
  antenna, users, and an **Open receiver** button.
- Opens in a new tab rather than inside the page: most receivers are plain HTTP, which
  an HTTPS site can't embed, and public Kiwis limit sessions and slots.

**Internet radio** (tested): Radio Browser, a free community directory of about 62,000
stations, some with coordinates. Click a dot and it plays in the page. This is the
easiest win here. HTTP-only streams need a link out, or a proxy we'd rather avoid
because of bandwidth.

**Propagation** (tested): WSPR via `wspr.live`, about 37,000 spots in 15 minutes.
Draws thin arcs between transmitter and receiver, showing where shortwave is open
right now. It's the most visually striking of the three and needs no receiver.

## Webcams

Built; see the README. Found while building: Windy's listing stops at offset 1000, so
the world is split into cells. `nearby` and `bbox` both work, and the player embeds
without a key. NYC DOT's API still can't be reached from here (2026-11-04), so it's left out. Windy's
rate limit isn't published: 4 requests a second tripped it within a minute, with a
`Retry-After` of about 47 s. We send under 2 a second and back off when told.

**Windy** (needs key): the biggest catalogue, but with tight rules. Free tier: image
links expire after 15 minutes, images are size-limited, listing depth is limited to
offset 1000, and the player may show ads. The terms require visible attribution and
linking every image to Windy, and they forbid redistribution, heavy automated use
and "publish[ing] any graphics displaying the Webcam images".

Safest use: markers, with the **Windy timelapse player embedded** on click, since
embedding the player is the use Windy offers. No thumbnails stored or proxied by us.
Load by map view on demand. Check the image clause with Windy before showing
thumbnails on a public site.

**Open cameras** (tested):
- Digitraffic road weather cameras: 816 stations in Finland, no key.
- Caltrans CCTV: statewide JSON by district, no key. Some records are old, so we filter
  by camera status.
- NYC DOT's API timed out from here; retry when building.
- US 511 systems need a per-state free key, so add them one at a time later.

Server keeps a merged list. Open cameras show a still image, refreshed while the panel is open.

**Not doing:** finding cameras through Shodan. Those are mostly private cameras that
are unsecured by accident, and showing them publicly would expose people.

---

## Lidar (dropped 2026-11-04)

Dropped: the interest was ocean scans, not land surveys. Kept for reference. See "Seafloor" below.

There is no worldwide lidar dataset. Coverage is a patchwork of national surveys, so
this splits into three things:

**1. Terrain and relief (recommended, works everywhere).** Mapterhorn (tested): free
terrain tiles, using Copernicus 30 m globally and national lidar at up to about 1 m
where available (Austria, for example). Its format works directly with MapLibre's
hillshade and 3D terrain. Adds a shaded-relief layer and an optional 3D terrain toggle.
Terrain on the globe needs testing with our deck.gl markers, which sit on a flat
surface today.

**2. Lidar coverage (recommended).** Outlines of where surveys exist:
- USGS 3DEP footprint file (tested, 2.5 MB GeoJSON, public domain).
- OpenTopography catalog API (tested, no key for catalog lookups).
Clicking a footprint shows the survey, date and point count, with a link to its data.

**3. Real point clouds in the browser (stretch).** USGS hosts its surveys in a streaming
format (Entwine). Each footprint carries its own link. deck.gl can draw points, but
we'd need a streaming reader, and that's a separate project. A simpler version is a
"view in 3D" button linking to an existing viewer.

National hillshades are also an option (England and Wales are under the Open Government
Licence; Wales has a WMS service), but Mapterhorn covers much of this already.

## Seafloor (scoped, not built)

**Proposed scope, 2026-11-04:**
- A fourth base map, **Seafloor**, beside Streets, Satellite and Daily. Labels and every data
  layer sit on top, and themes tint it like the other imagery.
- Imagery: NOAA's hillshade as a MapLibre raster source, using its `{bbox-epsg-3857}` URL. It
  covers the whole world, land included, and allows browser requests (CORS), so it costs
  our server nothing. Tiles took 0.8 to 1 s each in testing, so a fresh view fills in over a
  few seconds, and browsers cache them for 12 hours.
- Fallback: EMODnet tiles underneath, so a NOAA outage shows softer relief instead of a hole.
- Credit NOAA NCEI and EMODnet, and say it's not for navigation.
- Later, only if wanted: ship survey tracks, cached by us because NOAA takes 48 s per image, and
  a view of which seafloor was really measured rather than estimated. Each needs its own look.
- Before going public: confirm NOAA's terms. The service page lists none. EMODnet is CC BY 4.0
  and GEBCO is public domain with credit.

Small job: a source, a layer and a button, following the `sat-esri` pattern in `map.js`.

Found while dropping lidar, 2026-11-04. Ocean floor scans come mostly from ship sonar
(multibeam), and bathymetric lidar only reaches shallow coastal water. Only about 28.7% of
the seafloor has been mapped directly (Seabed 2030, April 2026). All tested from here:

- **NOAA DEM global mosaic hillshade:** `gis.ngdc.noaa.gov` ImageServer `exportImage`, no key.
  The best looking: Monterey Canyon is sharply detailed, land included. Cover depends on the
  area, and it's a live render rather than cached tiles.
- **BlueTopo (NOAA):** US waters only. WMTS on nowCOAST with `bluetopo:hillshade`, plus layers
  for survey ID, source institution and survey end date, so a click could say which
  survey made that patch. Quality varies: the Monterey sample was grey, with coarse triangles
  across the canyon head where the survey data is thin.
- **EMODnet Bathymetry:** global XYZ tiles at `tiles.emodnet-bathymetry.eu/2020/baselayer/web_mercator`,
  no key. Good around Europe, soft in the open ocean where it falls back on GEBCO.
- **GEBCO WMS:** global, Seabed 2030's public grid. Answers; sample image not checked.
- **NCEI multibeam tracks:** every archived ship survey, a striking world map. The dynamic
  service took 48 s for one image, and `maps.ngdc.noaa.gov` (cached) couldn't be reached from
  here, so this needs caching on our server or another source.

Not for navigation (EMODnet, GEBCO and BlueTopo all say so).

## Paused: UFO sightings

No free API exists. NUFORC has no API, blocks scripts and claims copyright, and the
January 2024 snapshot (147,890 reports) doesn't fit what this layer should be. Revisit
only if a free live source turns up.

---

## Next to research, plan and build

All approved. Each still needs its own research and plan before building.

1. **Watch zones.** Draw an area and get a browser notification when something happens
   there. Stored per viewer in the browser.
2. **Trains.** Digitraffic train positions (tested, no key). Finland first, then other
   open feeds.
3. **Air quality.** OpenAQ, free key. Pairs well with the fires layer.

Batch D is built; see the README. Found while building:
- IODA needs filtering, see the README. Its `events` route also reaches back two weeks.
- adsb.lol's `/v2/sqk/<code>` works worldwide with no key. airplanes.live now answers 403 and
  asks projects to email them, on its squawk and point routes. So our flights fallback no
  longer works, and adsb.lol is the only live source until that's sorted.
- Launch times have a precision field, from seconds to a quarter, so a countdown only runs for
  an hour or better.
- Not built: the launch link to Satellites. Payload names don't reliably match satellite names.

## Skipped or parked

- **TODO: look into Shodan and WiGLE integrations.** Notes from the first look:
  - Shodan: country totals with `/shodan/host/count` facets are documented as using no
    credits, for an Internet Exposure map. Attribute Shodan and find its full terms first.
    Shodan Monitor can also watch our own server once hosted. No individual devices or
    cameras on a public map: totals by country or city only.
  - WiGLE: its EULA covers personal, research and educational use, and bars giving third
    parties access to the data. Country and region totals worked without a key, for a
    Wireless Density map; confirm with WiGLE first. No individual networks shown publicly.
    A private view of your own wardriving needs a login.
- **UFO sightings:** paused, see above.
- **Submarine cables:** the good data is paid, and the free copy is non-commercial and from 2022.
- **Lightning:** couldn't confirm Blitzortung's terms.
- **Lidar:** dropped, see above.
- **Real point clouds in the browser:** a separate project, dropped with lidar.
- **Viewfinder marker, kept for another use:** corner brackets with a red recording dot, in the
  HUD style. The owner really likes it, so it should go on something else that deserves it. It was
  designed for webcams, which went with the camera badge instead. The artwork is in
  [viewfinder-marker.svg](design/viewfinder-marker.svg).

## Sources

- [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/)
- [Photon](https://github.com/komoot/photon)
- [Natural Earth country data](https://github.com/datasets/geo-countries)
- [Mapterhorn](https://mapterhorn.com/)
- [Seabed 2030 progress, IHO](https://iho.int/en/global-seabed-mapping-reaches-new-milestone-as-five-million-square-kilometres-added-in-a-year)
- [EMODnet Bathymetry tiles](https://emodnet.ec.europa.eu/en/bathymetry-web-visualization-terrain-tiling-and-interpolation-methods)
- [GEBCO WMS](https://gebco.net/news_and_media/gebco_2024_wms.html)
- [BlueTopo on nowCOAST](https://nauticalcharts.noaa.gov/updates/noaas-nowcoast-improves-bluetopo-access/)
- [USGS 3DEP lidar](https://www.usgs.gov/news/usgs-3dep-lidar-point-cloud-now-available-amazon-public-dataset)
- [Environment Agency National LIDAR Programme](https://ckan.publishing.service.gov.uk/dataset/national-lidar-programme)
- [NUFORC snapshot](https://huggingface.co/datasets/kcimc/NUFORC/blob/main/README.md)
- [Windy Webcams API](https://api.windy.com/webcams) and its [terms](https://account.windy.com/agreements/windy-webcams-api-terms-of-use)
- [Digitraffic](https://www.digitraffic.fi/en/service-overview/)
- [Shodan plans](https://account.shodan.io/billing), [API docs](https://developer.shodan.io/api), [InternetDB](https://internetdb.shodan.io/)
- [WiGLE EULA](https://wigle.net/eula.html), [API page](https://api.wigle.net/)
- [Cloudflare Radar](https://developers.cloudflare.com/radar/)
- [TeleGeography data license](https://www2.telegeography.com/hubfs/LP-Assets/Product-One-Pagers/geocoded-dataset-license.pdf)
