// The search box: results from /api/search, grouped, with keyboard control.
// Typing "lat, lon" offers a jump straight to those coordinates.

import { esc } from './layers/flight-panel.js';

const DEBOUNCE_MS = 220;
const COORDS = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

function coordinates(text) {
  const m = text.match(COORDS);
  if (!m) return null;
  const [lat, lon] = [Number(m[1]), Number(m[2])];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { type: 'place', label: `${lat}, ${lon}`, sub: 'Go to these coordinates', lon, lat, zoom: 10 };
}

export function createSearch({ form, input, list, onPick }) {
  let items = []; // flat list of what's showing, in display order
  let active = -1;
  let timer = 0;
  let request = null;

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function show(groups, query) {
    items = groups.flatMap((g) => g.items);
    let i = 0;
    const rows = groups.map((g) => `
      <h4>${esc(g.label)}</h4>
      ${g.items.map((item) => `
        <button type="button" role="option" id="sr-${i}" data-index="${i++}" aria-selected="false">
          <b>${esc(item.label)}</b>${item.sub ? `<small>${esc(item.sub)}</small>` : ''}
        </button>`).join('')}`).join('');
    list.innerHTML = rows
      ? `${rows}<p class="search-credit">Places: GeoNames, © OpenStreetMap via Photon</p>`
      : `<p class="search-empty">Nothing found for “${esc(query)}”.</p>`;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    setActive(items.length ? 0 : -1);
  }

  function setActive(i) {
    list.querySelector('[aria-selected="true"]')?.setAttribute('aria-selected', 'false');
    active = i;
    const el = list.querySelector(`[data-index="${i}"]`);
    if (!el) { input.removeAttribute('aria-activedescendant'); return; }
    el.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', el.id);
    el.scrollIntoView({ block: 'nearest' });
  }

  function pick(i) {
    const item = items[i];
    if (!item) return;
    close();
    input.value = item.label;
    input.blur();
    onPick(item);
  }

  async function run(text) {
    request?.abort();
    const q = text.trim();
    const coords = coordinates(q);
    if (q.length < 2 && !coords) { close(); return; }
    const controller = new AbortController();
    request = controller;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (request !== controller) return;
      show(coords ? [{ id: 'coords', label: 'Coordinates', items: [coords] }, ...d.groups] : d.groups, q);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('Search failed:', err.message);
      if (coords) show([{ id: 'coords', label: 'Coordinates', items: [coords] }], q);
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => run(input.value), DEBOUNCE_MS);
  });
  input.addEventListener('focus', () => { if (items.length && input.value) { list.hidden = false; input.setAttribute('aria-expanded', 'true'); } });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden || !items.length) return;
      setActive((active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
    } else if (e.key === 'Escape') {
      close();
      input.blur();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(timer);
    if (!list.hidden && active >= 0) pick(active);
    else run(input.value);
  });
  // mousedown, not click: click would come after the input's blur.
  list.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const row = e.target.closest('[data-index]');
    if (row) pick(Number(row.dataset.index));
  });
  document.addEventListener('pointerdown', (e) => { if (!form.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
}
