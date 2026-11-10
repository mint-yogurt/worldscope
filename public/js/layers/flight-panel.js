// Side panel for the selected aircraft. The structure lives in index.html
// (#flight-panel); this fills its slots. Upstream strings are always escaped.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SQUAWKS = { 7500: 'Hijack (squawk 7500)', 7600: 'Radio failure (squawk 7600)', 7700: 'Emergency (squawk 7700)' };
const fmt = (n, unit = '') => (Number.isFinite(n) ? `${Math.round(n).toLocaleString()}${unit}` : '—');

function stat(label, value) {
  return `<div><dt>${label}</dt><dd>${value}</dd></div>`;
}

export function createFlightPanel(root, { onClose, onFollow }) {
  const $ = (sel) => root.querySelector(sel);
  $('[data-close]').addEventListener('click', onClose);
  $('[data-follow]').addEventListener('click', onFollow);
  let photoFor = null;

  return {
    hide() { root.hidden = true; photoFor = null; },

    // p: live aircraft record; sel: { route, routePlausible, details, following, progress }
    render(p, sel) {
      root.hidden = false;
      const d = sel.details;
      const r = sel.route;

      $('[data-callsign]').textContent = p.flight || p.reg || d?.reg || p.hex.toUpperCase();
      $('[data-airline]').textContent = r?.airline || d?.owner || (p.mil ? 'Military' : '');

      const alert = $('[data-alert]');
      const sq = SQUAWKS[p.squawk] || (p.emergency ? `Emergency: ${p.emergency}` : '');
      alert.hidden = !sq;
      alert.textContent = sq;

      const fig = $('[data-photo]');
      if (d?.thumb && photoFor !== p.hex) {
        photoFor = p.hex;
        fig.querySelector('a').href = d.photo || d.thumb;
        fig.querySelector('img').src = d.thumb;
      }
      fig.hidden = !d?.thumb;

      const routeEl = $('[data-route]');
      if (r?.origin && r?.destination) {
        const pct = Math.round((sel.progress ?? 0) * 100);
        routeEl.hidden = false;
        routeEl.innerHTML = `
          <div class="fp-airports">
            <div><b>${esc(r.origin.iata || r.origin.icao)}</b><span>${esc(r.origin.city || r.origin.name)}</span></div>
            <div class="fp-bar"><i style="width:${pct}%"></i></div>
            <div><b>${esc(r.destination.iata || r.destination.icao)}</b><span>${esc(r.destination.city || r.destination.name)}</span></div>
          </div>
          ${sel.routePlausible ? '' : '<p class="fp-warn">Listed route doesn\'t match where this aircraft is. It may be out of date.</p>'}`;
      } else {
        routeEl.hidden = true;
      }

      const vr = Number.isFinite(p.vr) ? (Math.abs(p.vr) < 150 ? 'level' : `${p.vr > 0 ? '▲' : '▼'} ${fmt(Math.abs(p.vr), ' ft/min')}`) : '—';
      $('[data-stats]').innerHTML = [
        stat('Altitude', p.ground ? 'On ground' : fmt(p.alt, ' ft')),
        stat('Speed', fmt(p.gs, ' kt')),
        stat('Heading', Number.isFinite(p.track) ? `${Math.round(p.track)}°` : '—'),
        stat('Vertical', vr),
        stat('Type', esc(d?.type ? `${d.manufacturer || ''} ${d.type}`.trim() : p.type || '—')),
        stat('Registration', esc(p.reg || d?.reg || '—')),
        stat('Squawk', esc(p.squawk || '—')),
        stat('ICAO hex', esc(p.hex.toUpperCase())),
      ].join('');

      $('[data-follow]').setAttribute('aria-pressed', String(!!sel.following));
      const src = p.source === 'opensky' ? 'OpenSky snapshot' : `${p.source} live`;
      const age = (Date.now() - p.fixTime) / 1000;
      $('[data-source]').textContent = `${src} · position ${fmt(age)} s old${d?.country ? ` · registered in ${d.country}` : ''}`;
    },
  };
}
