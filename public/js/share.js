// Shareable links: the address bar always describes the current view.
//   #map=lat,lon,zoom[,bearing,pitch]&layers=ships,events&sel=ship:123&theme=matrix&mode=satellite&globe=0&tour=1

const fixed = (v, d) => String(Number(v.toFixed(d)));

export function parseLink(hash) {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const view = {};
  const m = (q.get('map') || '').split(',').map(Number);
  if (m.length >= 3 && m.every(Number.isFinite) && Math.abs(m[0]) <= 90 && Math.abs(m[1]) <= 180) {
    view.center = [m[1], m[0]];
    view.zoom = m[2];
    view.bearing = m[3] || 0;
    view.pitch = m[4] || 0;
  }
  if (q.has('layers')) view.layers = q.get('layers').split(',').filter(Boolean);
  const sel = q.get('sel');
  const split = sel?.indexOf(':') ?? -1;
  if (split > 0) view.selection = { type: sel.slice(0, split), id: sel.slice(split + 1) };
  for (const key of ['theme', 'mode']) if (q.has(key)) view[key] = q.get(key);
  if (q.has('globe')) view.globe = q.get('globe') !== '0';
  view.tour = q.has('tour');
  return view;
}

export function buildLink({ map, layers, selection, theme, mode, globe, tour, defaults }) {
  const c = map.getCenter();
  const bearing = map.getBearing();
  const pitch = map.getPitch();
  const place = [fixed(c.lat, 4), fixed(c.lng, 4), fixed(map.getZoom(), 2)];
  if (bearing || pitch) place.push(fixed(bearing, 1), fixed(pitch, 1));
  const parts = [`map=${place.join(',')}`, `layers=${layers.join(',')}`];
  if (selection) parts.push(`sel=${selection.type}:${encodeURIComponent(selection.id)}`);
  if (theme !== defaults.theme) parts.push(`theme=${theme}`);
  if (mode !== defaults.mode) parts.push(`mode=${mode}`);
  if (!globe) parts.push('globe=0');
  if (tour) parts.push('tour=1');
  return `#${parts.join('&')}`;
}
