// VENDORED, UNMODIFIED — exported from the owner's Sprite Lab tool
// (/Users/morphics/Downloads/export/recipes.js) and generated, not
// hand-written. Do not "improve" or refactor this file; regenerate it from
// the source tool instead if the art or animation logic needs to change.
// See ./README.txt for the sprite/rendering/XP contract this implements.
//
// SPRITE LAB — animation recipes and XP functions
// Pure functions. Each recipe takes (grid, frameIndex 0..3) and returns a NEW grid.
// A grid is 32 arrays of 32 single-character cells: '.' transparent, '1' darkest,
// '2' mid, '3' light, '4' accent. All recipes return to frame 0's state, so loops are seamless.

export const N = 32;
export const toGrid = rows => rows.map(r => r.split(''));
export const fromGrid = g => g.map(r => r.join(''));
const clone = g => g.map(r => r.slice());
const blankRow = () => Array(N).fill('.');

export function bbox(g) {
  let r0 = N, r1 = -1, c0 = N, c1 = -1;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (g[r][c] !== '.') {
    if (r < r0) r0 = r; if (r > r1) r1 = r; if (c < c0) c0 = c; if (c > c1) c1 = c;
  }
  return { r0, r1, c0, c1 };
}
function shiftAll(g, dx, dy) {
  const o = Array.from({ length: N }, blankRow);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const y = r + dy, x = c + dx;
    if (g[r][c] !== '.' && y >= 0 && y < N && x >= 0 && x < N) o[y][x] = g[r][c];
  }
  return o;
}
function shiftBand(g, r0, r1, dx) {
  const o = clone(g);
  for (let r = r0; r <= r1; r++) {
    o[r] = blankRow();
    for (let c = 0; c < N; c++) { const x = c + dx; if (x >= 0 && x < N) o[r][x] = g[r][c]; }
  }
  return o;
}
function rowExtent(g, r) {
  let a = -1, b = -1;
  for (let c = 0; c < N; c++) if (g[r][c] !== '.') { if (a < 0) a = c; b = c; }
  return [a, b];
}
function fractureAt(g, row, phase) {
  const jitter = [0, 0, -1, -1, 0, 1, 1, 0, -1, 0, 1, 1];
  const [a, z] = rowExtent(g, row), pts = [];
  if (a < 0) return pts;
  for (let c = a + 1; c <= z - 1; c++) {
    const r = row + jitter[(c - a + phase) % jitter.length];
    if (g[r] && g[r][c] !== '.') pts.push([r, c]);
  }
  return pts;
}

export const RECIPES = {
  // shift down 1px on alternate frames
  BOB: (g, f) => shiftAll(g, 0, f % 2),

  // silhouette expands 1px at its widest band
  BREATHE: (g, f) => {
    const amt = [0, 1, 1, 0][f];
    if (!amt) return clone(g);
    const b = bbox(g);
    let max = 0;
    for (let r = b.r0; r <= b.r1; r++) { const [a, z] = rowExtent(g, r); if (z - a + 1 > max) max = z - a + 1; }
    const o = clone(g);
    for (let r = b.r0; r <= b.r1; r++) {
      const [a, z] = rowExtent(g, r);
      if (a < 0 || z - a + 1 < max - 1) continue;
      if (a - 1 >= 0) o[r][a - 1] = g[r][a];
      if (z + 1 < N) o[r][z + 1] = g[r][z];
    }
    return o;
  },

  // bottom third shifts left / right
  WOBBLE: (g, f) => {
    const b = bbox(g), h = b.r1 - b.r0 + 1;
    return shiftBand(g, b.r1 - Math.floor(h / 3), b.r1, [0, -1, 0, 1][f]);
  },

  // top third sways, base anchored
  SWAY: (g, f) => {
    const b = bbox(g), h = b.r1 - b.r0 + 1;
    return shiftBand(g, b.r0, b.r0 + Math.floor(h / 3), [0, -1, 0, 1][f]);
  },

  // crown and base counter-sway
  THRASH: (g, f) => {
    const b = bbox(g), h = b.r1 - b.r0 + 1, dx = [0, -1, 0, 1][f];
    if (!dx) return clone(g);
    let o = shiftBand(g, b.r0, b.r0 + Math.floor(h / 3), dx);
    return shiftBand(o, b.r1 - Math.floor(h / 3), b.r1, -dx);
  },

  // accent cycles accent <-> light shade (falls back to light when no accent)
  PULSE: (g, f) => {
    const has4 = g.some(r => r.includes('4'));
    const src = has4 ? '4' : '3', to = f % 2 === 1 ? (has4 ? '3' : '2') : src;
    return g.map(r => r.map(ch => (ch === src ? to : ch)));
  },

  // accent points wink out for one beat
  BLINK: (g, f) => {
    if (f !== 2) return clone(g);
    const src = g.some(r => r.includes('4')) ? '4' : '3';
    return g.map(r => r.map(ch => (ch === src ? '1' : ch)));
  },

  // wings beat up and down, torso anchored
  FLAP: (g, f) => {
    const dy = [0, -1, 0, 1][f];
    if (!dy) return clone(g);
    const o = Array.from({ length: N }, blankRow);
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      if (g[r][c] === '.') continue;
      const y = r + (Math.abs(c - 15.5) > 2.5 ? dy : 0);
      if (y >= 0 && y < N) o[y][c] = g[r][c];
    }
    return o;
  },

  // whole body rises and settles; lift capped by available headroom
  HOVER: (g, f) => {
    const room = Math.min(2, bbox(g).r0);
    return shiftAll(g, 0, -Math.min([0, 1, 2, 1][f], room));
  },

  // alternating legs step in opposite phase
  STRIDE: (g, f) => {
    if (f === 0 || f === 2) return clone(g);
    const b = bbox(g), o = clone(g);
    const from = b.r0 + Math.floor((b.r1 - b.r0) * 0.55);
    const drop = f === 1 ? 0 : 1;
    for (let r = b.r1; r >= from; r--) for (let c = 0; c < N; c++) {
      if (g[r][c] === '.' || c % 2 !== drop) continue;
      o[r][c] = '.';
      if (r + 1 < N) o[r + 1][c] = g[r][c];
    }
    return o;
  },

  // sharp single-frame flinch
  TWITCH: (g, f) => (f === 1 ? shiftAll(g, -1, 0) : f === 3 ? shiftAll(g, 1, 0) : clone(g)),

  // light band sweeps head to tail
  RIPPLE: (g, f) => {
    const b = bbox(g), o = clone(g), h = b.r1 - b.r0 + 1;
    const row = b.r0 + Math.round((h - 1) * (f / 4));
    for (let d = 0; d < 2; d++) {
      const r = row + d;
      if (r < 0 || r > N - 1) continue;
      for (let c = 0; c < N; c++) if (o[r][c] === '2') o[r][c] = '3';
    }
    return o;
  },

  // light detail orbits the silhouette
  SPIN: (g, f) => {
    const o = clone(g);
    for (let r = 0; r < N; r++) {
      const lit = [];
      for (let c = 0; c < N; c++) if (g[r][c] === '3') lit.push(c);
      if (!lit.length) continue;
      for (const c of lit) o[r][c] = '2';
      for (const c of lit) {
        const x = c + [0, 1, 0, -1][f];
        if (o[r] && o[r][x] && o[r][x] !== '.' && o[r][x] !== '1') o[r][x] = '3';
      }
    }
    return o;
  },

  // accent pixels drift down and wrap
  DRIP: (g, f) => {
    const b = bbox(g), o = clone(g), moves = [];
    const src = g.some(r => r.includes('4')) ? '4' : '3';
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (g[r][c] === src) { o[r][c] = '2'; moves.push([r, c]); }
    for (const [r, c] of moves) {
      let y = r + f;
      if (y > b.r1) y = b.r0 + (y - b.r1 - 1);
      if (o[y] && o[y][c] !== '.' && o[y][c] !== '1') o[y][c] = src;
    }
    return o;
  },

  // fracture line reveals progressively
  CRACK: (g, f) => {
    const o = clone(g), b = bbox(g);
    const row = b.r0 + Math.max(2, Math.floor((b.r1 - b.r0 + 1) / 3));
    const path = fractureAt(g, row, 0);
    const n = Math.round((path.length * f) / 3);
    for (let i = 0; i < n; i++) { const [r, c] = path[i]; o[r][c] = '1'; }
    return o;
  },

  // body swings below its attachment point
  DANGLE: (g, f) => {
    const b = bbox(g), h = b.r1 - b.r0 + 1;
    return shiftBand(g, b.r0 + Math.floor(h / 3), b.r1, [0, -1, 0, 1][f]);
  }
};

// ---------------------------------------------------------------------------
// XP FUNCTIONS
// Each stage declares its XP behaviour explicitly. XP runs 0..100 and is applied
// to the BASE grid before the animation recipe.
//   crack -> eggs and pupae: shell fractures progressively, then breaches
//   grow  -> grubs and adults: juvenile at 0, authored size at 80, overgrown to 100
// ---------------------------------------------------------------------------
export const XP_MODE = { egg: 'crack', grub: 'grow', pupa: 'crack', adult: 'grow' };

function crackOps(g) {
  const b = bbox(g), ops = [], h = b.r1 - b.r0 + 1;
  const row = b.r0 + Math.max(2, Math.floor(h / 3));
  const spine = fractureAt(g, row, 0);
  if (!spine.length) return ops;
  const mid = Math.floor(spine.length / 2);
  // hairline out from the middle
  for (let i = 0; i < spine.length; i++) {
    const p = spine[mid + (i % 2 ? Math.ceil(i / 2) : -i / 2)];
    if (p) ops.push({ r: p[0], c: p[1], ch: '1' });
  }
  // branches climbing off the main fracture
  for (let i = 2; i < spine.length; i += 4) {
    const [r0, c0] = spine[i];
    for (let k = 1; k <= 3; k++) if (g[r0 - k] && g[r0 - k][c0] !== '.') ops.push({ r: r0 - k, c: c0, ch: '1' });
  }
  // shard glints
  for (let i = 1; i < spine.length; i += 5) {
    const [r0, c0] = spine[i];
    if (g[r0 + 1] && g[r0 + 1][c0] !== '.') ops.push({ r: r0 + 1, c: c0, ch: '3' });
  }
  // secondary fractures spreading over the whole shell
  for (const [rowOff, phase] of [[Math.floor(h * 0.66), 5], [Math.floor(h * 0.18), 9], [Math.floor(h * 0.85), 2]]) {
    const line = fractureAt(g, b.r0 + rowOff, phase);
    const m = Math.floor(line.length / 2);
    for (let i = 0; i < line.length; i++) {
      const p = line[m + (i % 2 ? Math.ceil(i / 2) : -i / 2)];
      if (p) ops.push({ r: p[0], c: p[1], ch: '1' });
    }
    for (let i = 3; i < line.length; i += 5) {
      const [r0, c0] = line[i];
      for (let k = 1; k <= 2; k++) if (g[r0 - k] && g[r0 - k][c0] !== '.') ops.push({ r: r0 - k, c: c0, ch: '1' });
    }
  }
  // shell blows out along the main fracture
  for (let k = 0; k < 10; k++) {
    const p = spine[mid - 4 + k];
    if (!p) continue;
    ops.push({ r: p[0], c: p[1], ch: '.' });
    if (g[p[0] - 1] && g[p[0] - 1][p[1]] !== '.') ops.push({ r: p[0] - 1, c: p[1], ch: '.' });
  }
  return ops;
}

function crackXp(g, xp) {
  if (!xp) return clone(g);
  const ops = crackOps(g), o = clone(g);
  const n = Math.round(ops.length * (xp / 100));
  for (let i = 0; i < n; i++) { const op = ops[i]; if (o[op.r]) o[op.r][op.c] = op.ch; }
  return o;
}

function growXp(g, xp) {
  const b = bbox(g);
  if (b.r1 < 0) return clone(g);
  const cy = (b.r0 + b.r1) / 2, cx = (b.c0 + b.c1) / 2;
  const room = v => (v <= 0 ? Infinity : v);
  const fMax = Math.min(
    room(cy - 1) / room(cy - b.r0),
    room(N - 2 - cy) / room(b.r1 - cy),
    room(cx - 1) / room(cx - b.c0),
    room(N - 2 - cx) / room(b.c1 - cx)
  );
  const roomy = Math.min(1.25, Math.max(1, fMax));
  const top = roomy > 1.1 ? roomy : 1;
  const f = xp <= 80 ? 0.62 + (xp / 80) * 0.38 : 1 + ((xp - 80) / 20) * (top - 1);
  if (Math.abs(f - 1) < 0.03) return clone(g);
  const o = Array.from({ length: N }, blankRow);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const sr = Math.round(cy + (r - cy) / f), sc = Math.round(cx + (c - cx) / f);
    if (g[sr] && g[sr][sc] && g[sr][sc] !== '.') o[r][c] = g[sr][sc];
  }
  // re-close the 1px outline after resampling
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (o[r][c] === '.') continue;
    const edge = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]
      .some(([y, x]) => !o[y] || !o[y][x] || o[y][x] === '.');
    if (edge) o[r][c] = '1';
  }
  return o;
}

export function applyXp(grid, xp, stage) {
  return (XP_MODE[stage] || 'crack') === 'grow' ? growXp(grid, xp) : crackXp(grid, xp);
}

// Full pipeline: sprite object + xp + frame index -> grid ready to draw
export function frame(sprite, xp, frameIndex) {
  const base = applyXp(toGrid(sprite.base), xp, sprite.stage || 'egg');
  const fn = RECIPES[sprite.recipe] || RECIPES.BOB;
  return fn(base, frameIndex % 4);
}

// Frame order for a loop: 'loop' plays 0-3, 'pingpong' plays 0-3-2-1
export const sequence = loop => (loop === 'pingpong' ? [0, 1, 2, 3, 2, 1] : [0, 1, 2, 3]);
