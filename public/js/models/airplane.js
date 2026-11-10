// Low-poly airliner built in code, so there's no model file to license.
// Units: fuselage length 1, nose toward +Y (north), wings along X, Z up.
// Flat-shaded triangles in the mesh format deck.gl's SimpleMeshLayer takes.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const avg = (pts) => pts.reduce((s, p) => add(s, p), [0, 0, 0]).map((x) => x / pts.length);
const mirror = (poly) => poly.map(([x, y, z]) => [-x, y, z]);

export function airplaneMesh() {
  const pos = [];
  const nrm = [];

  // Triangle wound so its normal faces away from `inside` (a point inside the part).
  function tri(a, b, c, inside) {
    let n = unit(cross(sub(b, a), sub(c, a)));
    if (dot(n, sub(avg([a, b, c]), inside)) < 0) {
      [b, c] = [c, b];
      n = n.map((x) => -x);
    }
    pos.push(...a, ...b, ...c);
    nrm.push(...n, ...n, ...n);
  }
  const quad = (a, b, c, d, inside) => { tri(a, b, c, inside); tri(a, c, d, inside); };

  // Convex flat polygon extruded by ±offset (wings, tail, engines).
  function slab(poly, offset) {
    const inside = avg(poly);
    const top = poly.map((p) => add(p, offset));
    const bot = poly.map((p) => sub(p, offset));
    for (let i = 1; i < poly.length - 1; i++) {
      tri(top[0], top[i], top[i + 1], inside);
      tri(bot[0], bot[i], bot[i + 1], inside);
    }
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      quad(top[i], top[j], bot[j], bot[i], inside);
    }
  }

  // Fuselage: rings of [y, radius] from tail to nose.
  const SIDES = 8;
  const rings = [[-0.5, 0.022], [-0.4, 0.05], [-0.28, 0.06], [0.28, 0.06], [0.42, 0.045], [0.5, 0]];
  const ring = ([y, r]) => Array.from({ length: SIDES }, (_, i) => {
    const a = (i / SIDES) * Math.PI * 2;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  });
  for (let k = 0; k < rings.length - 1; k++) {
    const A = ring(rings[k]);
    const B = ring(rings[k + 1]);
    const inside = [0, (rings[k][0] + rings[k + 1][0]) / 2, 0];
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES;
      if (rings[k + 1][1] === 0) tri(A[i], A[j], B[i], inside);
      else quad(A[i], A[j], B[j], B[i], inside);
    }
  }
  const tail = ring(rings[0]);
  for (let i = 1; i < SIDES - 1; i++) tri(tail[0], tail[i], tail[i + 1], [0, -0.45, 0]);

  // Swept wings, tailplane, fin, engines.
  const wing = [[0.05, 0.1, 0], [0.5, -0.1, 0], [0.5, -0.16, 0], [0.05, -0.1, 0]];
  slab(wing, [0, 0, 0.012]);
  slab(mirror(wing), [0, 0, 0.012]);
  const stab = [[0.02, -0.33, 0.012], [0.19, -0.44, 0.012], [0.19, -0.48, 0.012], [0.02, -0.46, 0.012]];
  slab(stab, [0, 0, 0.008]);
  slab(mirror(stab), [0, 0, 0.008]);
  slab([[0, -0.3, 0.04], [0, -0.45, 0.22], [0, -0.5, 0.22], [0, -0.49, 0.04]], [0.01, 0, 0]);
  for (const x of [-0.2, 0.2]) {
    slab([[x - 0.025, 0.1, -0.045], [x + 0.025, 0.1, -0.045], [x + 0.025, -0.04, -0.045], [x - 0.025, -0.04, -0.045]], [0, 0, 0.025]);
  }

  return {
    attributes: {
      positions: { value: new Float32Array(pos), size: 3 },
      normals: { value: new Float32Array(nrm), size: 3 },
      texCoords: { value: new Float32Array((pos.length / 3) * 2), size: 2 },
    },
  };
}
