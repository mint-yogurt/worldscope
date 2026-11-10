// Map badges: a colored shape with a dark symbol, plus a wider pill for each count
// length, used when markers cluster. All on a 24-unit grid. Sprites are full color,
// because a dark symbol on a colored shape can't be done with one tinted mask.
//   A kind is { id, color, shape, fill, stroke, pillRadius }: `shape` is the badge outline
//   and `fill` / `stroke` the symbol's paths. The layer list uses the same paths.

const INK = '#04101c';
const COUNT_COLOR = [4, 16, 28, 255];
const STROKE = 1.8;
const CELL = 96;
const PX = CELL / 24; // atlas pixels per badge unit
const PILL_WIDTHS = [36, 45, 54, 63]; // units, for 1 to 4 characters
// The count sits this far right of the middle of a pill, at any width.
const COUNT_OFFSET = 9.5;

export const SQUARE = 'M7 1h10a6 6 0 0 1 6 6v10a6 6 0 0 1-6 6H7a6 6 0 0 1-6-6V7a6 6 0 0 1 6-6z';
export const circle = (x, y, r) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0z`;
export const ROUND = circle(12, 12, 11);

export const badgeSvg = ({ color, shape, fill, stroke }) => `<svg class="map-badge" viewBox="0 0 24 24" aria-hidden="true">
  <path d="${shape}" fill="${color}" stroke="${INK}" stroke-width="1.5"/>
  ${fill ? `<path d="${fill}" fill="${INK}"/>` : ''}
  ${stroke ? `<path d="${stroke}" fill="none" stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
</svg>`;

// Returns { canvas, mapping }. Icons are named `id` and, for pills, `id-<length>`.
export function badgeAtlas(kinds) {
  const widths = [24, ...PILL_WIDTHS];
  const canvas = document.createElement('canvas');
  canvas.width = widths.reduce((sum, w) => sum + w, 0) * PX;
  canvas.height = CELL * kinds.length;
  const ctx = canvas.getContext('2d');
  const mapping = {};
  kinds.forEach((kind, row) => {
    let left = 0;
    widths.forEach((w, i) => {
      ctx.setTransform(PX, 0, 0, PX, left * PX, row * CELL);
      const outline = new Path2D();
      if (i) outline.roundRect(1, 1, w - 2, 22, kind.pillRadius ?? 8);
      else outline.addPath(new Path2D(kind.shape));
      ctx.fillStyle = kind.color;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.fill(outline);
      ctx.stroke(outline);
      ctx.fillStyle = INK;
      if (kind.fill) ctx.fill(new Path2D(kind.fill));
      if (kind.stroke) {
        ctx.lineWidth = STROKE;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke(new Path2D(kind.stroke));
      }
      mapping[i ? `${kind.id}-${i}` : kind.id] = { x: left * PX, y: row * CELL, width: w * PX, height: CELL, mask: false };
      left += w;
    });
  });
  return { canvas, mapping };
}

// At most 4 characters, so the count always fits a pill.
const countText = (n) => (n < 10_000 ? String(n) : `${Math.floor(n / 1000)}k`);

export const pillIcon = (id, count) => `${id}-${countText(count).length}`;

// The numbers on the pills in `data` (anything with `members`).
export function countLayer(id, data, pillSize, parameters) {
  return new deck.TextLayer({
    id,
    data,
    getPosition: (c) => [c.lon, c.lat],
    getText: (c) => countText(c.members.length),
    getSize: pillSize * 0.6,
    getColor: COUNT_COLOR,
    getPixelOffset: [(COUNT_OFFSET * pillSize) / 24, 0],
    getTextAnchor: 'middle',
    getAlignmentBaseline: 'center',
    characterSet: '0123456789k',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontWeight: 700,
    sizeUnits: 'pixels',
    billboard: true,
    parameters,
    updateTriggers: { getSize: pillSize, getPixelOffset: pillSize },
  });
}
