// Emergencies strip: a small live list of what's urgent across layers, under the top bar.
// It hides when there's nothing to show. Hiding it by hand lasts until something new
// appears. Data via server/sources/emergencies.js.

import { esc } from './flight-panel.js';

const REFRESH_MS = 60_000;
const ICONS = { flight: '✈', ship: '⚓', radiation: '☢', event: '⚠', outage: '📡' };

export function createEmergencies({ el, extraEl, onOpen, onCount, onStatus }) {
  let enabled = false;
  let timer = 0;
  let items = [];
  let unavailable = [];
  let open = false;
  let dismissed = new Set(); // ids showing when the strip was hidden

  function render() {
    const fresh = items.filter((item) => !dismissed.has(item.id));
    el.hidden = !enabled || !fresh.length;
    onCount(enabled ? items.length : null);
    onStatus(enabled && unavailable.length ? `⚠ ${unavailable.join(', ')} checks unavailable` : '');
    if (el.hidden) return;
    const [top] = items;
    const critical = items.some((item) => item.level === 'critical');
    el.dataset.level = critical ? 'critical' : 'warning';
    el.innerHTML = `
      <div class="alerts-bar">
        <button class="alerts-toggle" data-toggle aria-expanded="${open}">
          <i aria-hidden="true"></i>
          <b>${items.length} ${items.length === 1 ? 'alert' : 'alerts'}</b>
          <span>${esc(top.title)}</span>
          <em aria-hidden="true">${open ? '▴' : '▾'}</em>
        </button>
        <button class="icon-btn" data-dismiss aria-label="Hide alerts">✕</button>
      </div>
      ${open ? `<ul class="alerts-list">${items.map((item, i) => `
        <li><button data-item="${i}" data-level="${item.level}">
          <i aria-hidden="true">${ICONS[item.kind] || '⚠'}</i>
          <span><b>${esc(item.title)}</b><small>${esc(item.sub)}</small></span>
        </button></li>`).join('')}</ul>
        ${unavailable.length ? `<p class="ev-hint">Not checked right now: ${esc(unavailable.join(', '))}.</p>` : ''}` : ''}`;
  }

  async function load() {
    if (document.hidden) return;
    try {
      const res = await fetch('/api/emergencies');
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (!enabled) return;
      items = d.items;
      unavailable = d.unavailable;
      render();
    } catch (err) {
      console.error(err);
      onStatus(`Emergencies failed to load: ${err.message}`);
    }
  }

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-toggle]')) {
      open = !open;
      render();
    } else if (e.target.closest('[data-dismiss]')) {
      open = false;
      dismissed = new Set(items.map((item) => item.id));
      render();
    } else {
      const row = e.target.closest('[data-item]');
      if (!row) return;
      const item = items[Number(row.dataset.item)];
      onOpen({ ...item.open, lon: item.lon, lat: item.lat });
    }
  });
  document.addEventListener('visibilitychange', () => { if (enabled) load(); });

  return {
    setTheme() { /* styled by the page's theme colors */ },
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      extraEl.hidden = !on;
      extraEl.innerHTML = '<p class="ev-hint">Emergency squawks, distress beacons, very high radiation, major disasters and internet outages. Automatic signals can be tests or mistakes.</p>';
      clearInterval(timer);
      if (on) {
        load();
        timer = setInterval(load, REFRESH_MS);
      }
      render();
    },
  };
}
