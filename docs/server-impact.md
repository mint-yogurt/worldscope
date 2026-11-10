# Server impact

Measured on the dev machine on 2026-11-04, 18 minutes after a start with the worldwide
ship feed on and 25,000 ships in memory. Network rates are from short samples at one
time of day, so treat them as a rough guide.

## Summary

Only one thing is heavy: the worldwide ship stream. Everything else is either already
on-demand or too small to matter. Ship sleep mode (built, see below) stops that stream
when nobody is watching, which removes about 97% of idle traffic and loses nothing
that can't be rebuilt in minutes.

## Without sleep mode

The measurements below were taken with every feed running.

| What runs | Why it can't just wait | Download |
|---|---|---|
| aisstream.io ship stream | Must stay connected to fill the table | about 5 GB/day (470 kbit/s) |
| Digitraffic ship polling | Same | about 60 MB/day |
| Events ingest (USGS 5 min, GDACS 15 min, EONET and Wikipedia 30 min) | Builds the 30-day history | estimated under 100 MB/day |
| Flights, radiation, weather, satellites, aurora, radio, webcams, outages, launches, emergencies | **Nothing runs.** They fetch when someone asks, then cache | 0 |

So about **150 GB/month** with ships on, or about **4 GB/month** without the stream.

| Resource | Measured | Expected on a server |
|---|---|---|
| CPU | 4.5 s of CPU in 18 minutes (0.4% of one core) | Any small VPS is fine |
| Memory | 100 MB with 25,000 ships | 150–250 MB at a full table |
| Disk | 13 MB in `data/`; events are pruned, the file cache expires | Stays in the tens of MB |

The ship table holds only memory, and it's lost on restart. Nothing grows without limit.

## With someone viewing

This is upload from your server, so it's what counts against a hosting allowance.

| Item | Size | How often |
|---|---|---|
| Ships, whole world | 500 KB | every 30 s |
| Flights, whole world | 260 KB | every 30 s, plus live data when zoomed in |
| Radiation | 60 KB | every 10 min |
| Events | 10 KB | periodically |
| Satellites | 940 KB | once per visit |
| Radio stations | 410 KB | once per visit |
| Radio receivers | 120 KB | every 30 min |
| Shortwave paths | 75 KB | every 3 min |
| Webcams | 450 KB before compression for the world, less zoomed in | when the view moves |
| Rocket launches | 50 KB before compression | every 20 min |
| Internet outages | under 5 KB | every 10 min |
| Emergencies | under 5 KB | every minute |

One viewer with everything on, zoomed out, uses about **90 MB/hour**. Zoomed in, ships
shrink to the view. Base map and most weather tiles load from their own providers
and never touch your server. Neither do internet radio streams, SDR receivers, webcam
images or the Windy player: they go straight from the source to the viewer.

The figure of 90 MB/hour was measured before Radio, webcams and Batch D. Shortwave paths add
about 2 MB/hour and the rest far less, so it isn't a big change. Emergencies are on by
default and ask adsb.lol three times a minute while anyone is viewing.

## Sleep mode for ships

Built. The work is split by whether it can be rebuilt:

- **Runs 24/7: events.** They accumulate history, so missing them would leave real
  gaps. They're also tiny.
- **Sleeps when nobody is viewing: ships.** They're a live picture only. Ten minutes
  after the last viewer, the aisstream socket closes and Digitraffic polling stops.
  The server also starts asleep, so a restart costs nothing until someone visits.
- **No change: everything else.** It already sleeps by design.

**What counts as a viewer:** an open page reports to `/api/presence` every minute while
its tab is visible. A hidden tab or minimized window doesn't count, and neither do
crawlers, because they don't run the page's script. Any viewer wakes ships, even with
the ships layer off, so search and country panels have data and the map is ready when
the layer is turned on.

The wait can be changed with the environment variable `SHIPS_IDLE_MINUTES`. It's read
at startup, and it has to be a real environment variable because `secrets.env` loads
too late for it.

**What's kept while asleep:** the table stays in memory, and ships are dropped by the
usual 3-hour rule. After a short sleep, moored ships are still there and moving ones
return as they report in.

**The cost:** the map starts thin after waking. In testing it reached 4,800 ships in
about 2 minutes, 17,000 in 8 and 25,000 in 18. Ship types take a similar time to fill in.

**Result:** idle traffic drops to about 4 GB/month, and the server idles at near zero CPU.

Hosting needs are small either way: 1 vCPU, 512 MB of RAM and 1 GB of disk is plenty.
If the host has a bandwidth cap, sleep mode matters more than the server size.
