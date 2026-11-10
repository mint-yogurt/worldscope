// One deck.gl overlay shared by every data layer. Each feature registers its
// layers under a group name; layer ids are "<group>:<name>" so tooltips can
// be routed back to the feature that owns them.

// deck.gl only fills `info.object` for plain-array data. Layers fed typed arrays
// (satellites use an Int32Array of indices) get it looked up here instead.
function withObject(info) {
  if (!info?.layer || info.index < 0) return null;
  if (info.object === undefined) info.object = info.layer.props.data?.[info.index];
  return info.object === undefined ? null : info;
}

export function createOverlay(map) {
  const groups = new Map();
  const tooltips = new Map();

  const overlay = new deck.MapboxOverlay({
    interleaved: true,
    layers: [],
    getTooltip: (picked) => {
      const info = withObject(picked);
      if (!info) return null;
      const html = tooltips.get(info.layer.id.split(':')[0])?.(info.object);
      return html ? { html, className: 'map-tooltip' } : null;
    },
    getCursor: ({ isHovering, isDragging }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : ''),
  });
  map.addControl(overlay);

  return {
    set(group, layers) {
      groups.set(group, layers);
      overlay.setProps({ layers: [...groups.values()].flat() });
      // Interleaved deck layers only draw when MapLibre renders a frame, and new
      // layers need a frame to set up before they show. Ask for two, or changes
      // stay invisible until something else moves the map.
      map.triggerRepaint();
      requestAnimationFrame(() => map.triggerRepaint());
    },
    tooltip(group, fn) {
      tooltips.set(group, fn);
    },
    // Returns the picked info (with `object` filled in) or null when nothing is under the point.
    pick(point, layerIds) {
      return withObject(overlay.pickObject({ x: point.x, y: point.y, radius: 6, layerIds }));
    },
  };
}
