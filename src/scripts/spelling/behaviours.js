import { CENTER } from './charmap.js';
import { ease, easeOut } from './shapes.js';

export const MODES = [
  'direct', 'swirl', 'implode', 'wave', 'ripple',
  'spin', 'split', 'orbit', 'shear',
  'vortex', 'fold', 'cascade', 'tendril', 'boil',
  'unwind', 'magnet', 'snake', 'inhale',
  'peel', 'braid', 'lathe',
  'seam', 'quench', 'furl', 'knit'
];

// Dormant has no choreography — just endless reshaping.
export const IDLE_MODE = 'direct';

export function pickMode(previous) {
  if (MODES.length < 2) return MODES[0];
  let m = MODES[Math.floor(Math.random() * MODES.length)];
  while (m === previous) m = MODES[Math.floor(Math.random() * MODES.length)];
  return m;
}

// Per-particle stagger, so a behaviour sweeps across the form instead of moving
// every point at once. Returns the fraction of the morph this point sits out.
export function leadFor(mode, b, i, n, seed) {
  if (mode === 'wave') return (b.x / 120) * 0.42;
  if (mode === 'ripple') return (Math.hypot(b.x - CENTER, b.y - CENTER) / 44) * 0.38;
  if (mode === 'seam') return (Math.abs(b.x - CENTER) / 44) * 0.4;
  if (mode === 'knit') return (i % 2) * 0.3;
  if (mode === 'boil') return seed * 0.34;
  if (mode === 'split') return b.y < CENTER ? 0 : 0.28;
  if (mode === 'cascade') return (b.y / 120) * 0.44;
  if (mode === 'snake') return (i / n) * 0.5;
  return 0;
}

// Displace one interpolated point. `tt` is this point's staggered progress.
// Motion must peak mid-transition and fall away on arrival — that is what makes
// it read as fluid rather than as sliding. All behaviours are volume-preserving.
export function displace(mode, a, b, tt, i, seed, now) {
  const C = CENTER;
  let e = ease(tt);
  if (mode === 'magnet') e = tt * tt * tt * tt;
  else if (mode === 'tendril') e = tt < 1 ? 1 - Math.pow(1 - tt, 2.2) : 1;

  const k = Math.sin(Math.PI * tt);

  if (mode === 'swirl' || mode === 'orbit') {
    const ang = Math.PI * (mode === 'orbit' ? 1.35 : 0.75) * (1 - e);
    const dx = a.x - C, dy = a.y - C;
    const ax = C + dx * Math.cos(ang) - dy * Math.sin(ang);
    const ay = C + dx * Math.sin(ang) + dy * Math.cos(ang);
    return { x: ax + (b.x - ax) * e, y: ay + (b.y - ay) * e };
  }
  if (mode === 'spin') {
    const ang = Math.PI * 2 * (1 - easeOut(tt));
    const mx = a.x + (b.x - a.x) * e, my = a.y + (b.y - a.y) * e;
    const dx = mx - C, dy = my - C;
    return {
      x: C + dx * Math.cos(ang) - dy * Math.sin(ang),
      y: C + dx * Math.sin(ang) + dy * Math.cos(ang)
    };
  }
  if (mode === 'implode') {
    const mx = a.x + (b.x - a.x) * e, my = a.y + (b.y - a.y) * e;
    return { x: C + (mx - C) * (1 - 0.62 * k), y: C + (my - C) * (1 - 0.62 * k) };
  }
  if (mode === 'shear') {
    return { x: a.x + (b.x - a.x) * e + (a.y - C) * 0.5 * k, y: a.y + (b.y - a.y) * e };
  }
  if (mode === 'split') {
    return { x: a.x + (b.x - a.x) * e + (b.y < C ? -1 : 1) * 26 * k, y: a.y + (b.y - a.y) * e };
  }
  if (mode === 'vortex') {
    const rr = Math.hypot(a.x - C, a.y - C) / 44;
    const ang = Math.PI * 2.2 * (1 - e) * (0.35 + rr);
    const dx = a.x - C, dy = a.y - C;
    const ax = C + dx * Math.cos(ang) - dy * Math.sin(ang);
    const ay = C + dx * Math.sin(ang) + dy * Math.cos(ang);
    return {
      x: (ax + (b.x - ax) * e - C) * (1 - 0.3 * k) + C,
      y: (ay + (b.y - ay) * e - C) * (1 - 0.3 * k) + C
    };
  }
  if (mode === 'fold') {
    return { x: C + (a.x + (b.x - a.x) * e - C) * (1 - 0.88 * k), y: a.y + (b.y - a.y) * e };
  }
  if (mode === 'unwind') {
    const ang = -Math.PI * 1.8 * (1 - easeOut(tt));
    const mx = a.x + (b.x - a.x) * e, my = a.y + (b.y - a.y) * e;
    const sc = 0.5 + 0.5 * easeOut(tt);
    const dx = (mx - C) * sc, dy = (my - C) * sc;
    return {
      x: C + dx * Math.cos(ang) - dy * Math.sin(ang),
      y: C + dx * Math.sin(ang) + dy * Math.cos(ang)
    };
  }
  if (mode === 'tendril') {
    const over = k * 16;
    const vx = b.x - a.x, vy = b.y - a.y;
    const L = Math.hypot(vx, vy) || 1;
    return {
      x: a.x + vx * e + (vx / L) * over * (0.4 + seed * 0.6),
      y: a.y + vy * e + (vy / L) * over * (0.4 + seed * 0.6)
    };
  }
  if (mode === 'boil') {
    return {
      x: a.x + (b.x - a.x) * e + Math.sin(now / 90 + seed * 30) * 9 * k,
      y: a.y + (b.y - a.y) * e + Math.cos(now / 105 + seed * 21) * 9 * k
    };
  }
  if (mode === 'peel') {
    // the far side lifts away first, the mass rolls over itself
    const side = (a.x - C) / 44;
    return {
      x: a.x + (b.x - a.x) * e + side * 18 * k,
      y: a.y + (b.y - a.y) * e - Math.abs(side) * 12 * k
    };
  }
  if (mode === 'braid') {
    // two counter-rotating halves cross through each other
    const ang = ((i % 2) ? 1 : -1) * 0.9 * k;
    const mx = a.x + (b.x - a.x) * e, my = a.y + (b.y - a.y) * e;
    const dx = mx - C, dy = my - C;
    return {
      x: C + dx * Math.cos(ang) - dy * Math.sin(ang),
      y: C + dx * Math.sin(ang) + dy * Math.cos(ang)
    };
  }
  if (mode === 'lathe') {
    // spun on a vertical axis — horizontal squeeze, no area change
    return {
      x: C + (a.x + (b.x - a.x) * e - C) * (1 - 0.7 * k),
      y: C + (a.y + (b.y - a.y) * e - C) * (1 + 0.22 * k)
    };
  }
  if (mode === 'seam') {
    // halves part at the centre line, then close on the new form
    return { x: a.x + (b.x - a.x) * e + (b.x < C ? -1 : 1) * 20 * k, y: a.y + (b.y - a.y) * e };
  }
  if (mode === 'quench') {
    // tightens hard, then relaxes out — a contraction, never a swell
    const mx = a.x + (b.x - a.x) * e, my = a.y + (b.y - a.y) * e;
    return { x: C + (mx - C) * (1 - 0.45 * k), y: C + (my - C) * (1 - 0.45 * k) };
  }
  if (mode === 'furl') {
    // rolls in from the rim, rotation strongest at the edge
    const rr = Math.hypot(b.x - C, b.y - C) / 44;
    const ang = 1.5 * (1 - easeOut(tt)) * rr;
    const mx = a.x + (b.x - a.x) * e, my = a.y + (b.y - a.y) * e;
    const dx = mx - C, dy = my - C;
    return {
      x: C + dx * Math.cos(ang) - dy * Math.sin(ang),
      y: C + dx * Math.sin(ang) + dy * Math.cos(ang)
    };
  }
  if (mode === 'knit') {
    // alternating particles take opposite arcs and interlace
    const vx = b.x - a.x, vy = b.y - a.y;
    const L = Math.hypot(vx, vy) || 1;
    const dir = (i % 2) ? 1 : -1;
    return {
      x: a.x + vx * e + (-vy / L) * 17 * k * dir,
      y: a.y + vy * e + (vx / L) * 17 * k * dir
    };
  }
  if (mode === 'inhale') {
    // draws inward and releases — no outward lobe
    const mx = a.x + (b.x - a.x) * e, my = a.y + (b.y - a.y) * e;
    return { x: C + (mx - C) * (1 - 0.3 * k), y: C + (my - C) * (1 - 0.14 * k) };
  }
  return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
}
