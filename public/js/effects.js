// Full-screen canvas effects that sit above the map and below the UI.
// Each theme names one in themes.js; the canvas never takes pointer events.
// Colors come from the active theme's CSS (--fx-1 / --fx-2).

const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789:.=*+-<>';

function cssColors() {
  const cs = getComputedStyle(document.documentElement);
  return [cs.getPropertyValue('--fx-1').trim(), cs.getPropertyValue('--fx-2').trim()];
}

// Falling code columns. Fades trails with destination-out so the map shows through.
function rain(ctx, w, h) {
  const size = 16;
  const drops = Array.from({ length: Math.ceil(w / size) }, () => Math.random() * -h / size);
  const [head, body] = cssColors();
  let last = 0;
  ctx.font = `${size}px "Share Tech Mono", monospace`;
  return (t) => {
    if (t - last < 55) return; // ~18 fps reads more like the real thing
    last = t;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    drops.forEach((y, i) => {
      const ch = GLYPHS[(Math.random() * GLYPHS.length) | 0];
      ctx.fillStyle = Math.random() < 0.08 ? head : body;
      ctx.fillText(ch, i * size, y * size);
      drops[i] = y * size > h && Math.random() > 0.975 ? 0 : y + 1;
    });
  };
}

// Soft glowing particles. "embers" rise and flicker; "dust" drifts down slowly.
function particles(ctx, w, h, kind) {
  const rising = kind === 'embers';
  const colors = cssColors();
  const count = Math.round((w * h) / (rising ? 26000 : 20000));
  const spawn = (anywhere) => ({
    x: Math.random() * w,
    y: anywhere ? Math.random() * h : rising ? h + 10 : -10,
    vx: (Math.random() - 0.5) * 0.3,
    vy: rising ? -(0.3 + Math.random() * 0.7) : 0.15 + Math.random() * 0.35,
    r: 0.8 + Math.random() * (rising ? 2.2 : 1.6),
    phase: Math.random() * Math.PI * 2,
    color: colors[Math.random() < 0.7 ? 0 : 1],
  });
  const ps = Array.from({ length: count }, () => spawn(true));
  return (t) => {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.x += p.vx + Math.sin(t / 1400 + p.phase) * 0.15;
      p.y += p.vy;
      if (p.y < -20 || p.y > h + 20 || p.x < -20 || p.x > w + 20) ps[i] = spawn(false);
      const flicker = 0.55 + 0.45 * Math.sin(t / (rising ? 180 : 600) + p.phase);
      ctx.globalAlpha = flicker;
      ctx.shadowBlur = p.r * 6;
      ctx.shadowColor = p.color;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  };
}

const EFFECTS = {
  rain,
  embers: (ctx, w, h) => particles(ctx, w, h, 'embers'),
  dust: (ctx, w, h) => particles(ctx, w, h, 'dust'),
};

export function createEffects(canvas) {
  const ctx = canvas.getContext('2d');
  let name = null;
  let frame = null;
  let raf = 0;

  function start() {
    cancelAnimationFrame(raf);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    frame = name && EFFECTS[name] ? EFFECTS[name](ctx, w, h) : null;
    if (!frame) return;
    const loop = (t) => { frame(t); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(start, 150);
  });

  return {
    set(next) {
      name = next;
      start();
    },
  };
}
