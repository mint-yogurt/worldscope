// Tour mode: the globe flies between the most interesting things happening now, with a
// caption at each stop. Good as a wall display, and a link with &tour=1 starts it.
// Space pauses, the arrow keys skip, Esc ends it, and dragging the map pauses it.
// Stops come from /api/tour and are fetched again each time round.

const FLY_MS = 6000;
const STAY_MS = 14_000;
const OPEN_WAIT_MS = 8000; // a layer that's slow to load shouldn't hold the tour up
const EMPTY_RETRY_MS = 60_000;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

export function createTour({ map, els, open, reducedMotion, onStart, onStop }) {
  let running = false;
  let paused = false;
  let stops = [];
  let index = -1;
  let turn = 0; // moves on with each stop, so a slow step can tell it's out of date
  let timer = 0;
  let leftMs = 0;
  let startedAt = 0;
  let bar = null;

  async function fetchStops() {
    try {
      const res = await fetch('/api/tour');
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      stops = d.stops;
    } catch (err) {
      console.error(err);
      stops = [];
    }
  }

  function caption(stop) {
    els.kicker.textContent = stop.kicker || '';
    els.title.textContent = stop.title;
    els.sub.textContent = stop.sub || '';
    els.step.textContent = `${index + 1} of ${stops.length}`;
    els.card.hidden = false;
  }

  // Resolves on arrival. In a hidden tab the map doesn't animate, so there's a limit.
  function fly(stop) {
    if (!Number.isFinite(stop.lon) || !Number.isFinite(stop.lat)) return Promise.resolve();
    const to = { center: [stop.lon, stop.lat], zoom: stop.zoom ?? 5, bearing: 0, pitch: 0 };
    if (reducedMotion) {
      map.jumpTo(to);
      return Promise.resolve();
    }
    map.flyTo({ ...to, duration: FLY_MS, curve: 1.5, essential: true });
    return Promise.race([new Promise((r) => { map.once('moveend', r); }), sleep(FLY_MS + 1500)]);
  }

  function stay(ms) {
    leftMs = ms;
    bar?.cancel();
    bar = els.bar.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: ms, fill: 'forwards' });
    if (paused) {
      bar.pause();
      return;
    }
    resumeTimer();
  }

  function resumeTimer() {
    startedAt = Date.now();
    timer = setTimeout(() => go(index + 1), leftMs);
  }

  async function go(i) {
    const mine = ++turn;
    clearTimeout(timer);
    if (i >= stops.length || i < 0) {
      await fetchStops();
      if (mine !== turn || !running) return;
      if (!stops.length) {
        timer = setTimeout(() => go(0), EMPTY_RETRY_MS);
        return;
      }
      i = 0;
    }
    index = i;
    const stop = stops[i];
    caption(stop);
    bar?.cancel();
    await fly(stop);
    if (mine !== turn || !running) return;
    await Promise.race([open({ ...stop, fly: false }), sleep(OPEN_WAIT_MS)]).catch((err) => console.warn('Tour stop failed:', err.message));
    if (mine !== turn || !running) return;
    stay(STAY_MS);
  }

  function setPaused(on) {
    if (on === paused || !running) return;
    paused = on;
    els.pause.textContent = on ? '▶' : '⏸';
    els.pause.setAttribute('aria-label', on ? 'Resume tour' : 'Pause tour');
    if (on) {
      if (timer) leftMs = Math.max(0, leftMs - (Date.now() - startedAt));
      clearTimeout(timer);
      timer = 0;
      bar?.pause();
    } else if (bar && bar.playState === 'paused') {
      bar.play();
      resumeTimer();
    }
  }

  function start() {
    if (running) return;
    running = true;
    paused = false;
    stops = [];
    els.pause.textContent = '⏸';
    onStart();
    document.body.classList.add('touring');
    go(0);
  }

  function stop() {
    if (!running) return;
    running = false;
    turn++;
    clearTimeout(timer);
    bar?.cancel();
    map.stop();
    els.card.hidden = true;
    document.body.classList.remove('touring');
    onStop();
  }

  els.pause.addEventListener('click', () => setPaused(!paused));
  els.next.addEventListener('click', () => go(index + 1));
  els.prev.addEventListener('click', () => go(Math.max(0, index - 1)));
  els.stop.addEventListener('click', stop);
  map.on('dragstart', () => setPaused(true));
  document.addEventListener('keydown', (e) => {
    if (!running) return;
    if (e.key === 'Escape') stop();
    else if (e.key === ' ') { e.preventDefault(); setPaused(!paused); } else if (e.key === 'ArrowRight') go(index + 1);
    else if (e.key === 'ArrowLeft') go(Math.max(0, index - 1));
  });

  return { start, stop, running: () => running };
}
