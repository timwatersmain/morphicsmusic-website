import { CENTER } from './charmap.js';

const SECTORS = 24;

// Pair source -> target so particles take short, non-crossing routes.
// Sorting by angle ALONE lets a point cross through the centre to reach its
// target, which visibly collapses the mass mid-morph. The radius term prevents it.
export function assign(src, dst) {
  const key = p => {
    const a = Math.atan2(p.y - CENTER, p.x - CENTER);
    const s = Math.floor((a + Math.PI) / (2 * Math.PI) * SECTORS);
    return s * 1000 + Math.hypot(p.x - CENTER, p.y - CENTER);
  };
  const si = src.map((p, i) => [key(p), i]).sort((a, b) => a[0] - b[0]);
  const di = dst.map((p, i) => [key(p), i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(src.length);
  for (let i = 0; i < si.length; i++) out[si[i][1]] = dst[di[i][1]];
  return out;
}

// Bounding box of a point field. w/h are floored at 1 so the framing lock,
// which divides by them, can never blow up on a degenerate field.
export function box(pts) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: (x1 - x0) || 1, h: (y1 - y0) || 1 };
}
