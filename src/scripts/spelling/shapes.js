import { CENTER } from './charmap.js';

const GOLD = Math.PI * (3 - Math.sqrt(5));

// A filled disc of radius 30 — what a space collapses to.
export function spherePoints(n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const r = 30 * Math.sqrt((i + 0.5) / n);
    const a = i * GOLD;
    pts.push({ x: CENTER + Math.cos(a) * r, y: CENTER + Math.sin(a) * r });
  }
  return pts;
}

// A formless lumpy mass — never the same twice. Low harmonics (2nd and 3rd) only:
// higher ones read as lumpy and starred rather than as a soft body.
export function blobShape(n) {
  const pts = [];
  const p1 = Math.random() * 6.28, p2 = Math.random() * 6.28;
  const a1 = 0.09 + Math.random() * 0.10, a2 = 0.04 + Math.random() * 0.06;
  const h1 = 2, h2 = 3;
  const squash = 0.90 + Math.random() * 0.18;
  const tilt = Math.random() * 6.28;
  for (let i = 0; i < n; i++) {
    const f = Math.sqrt((i + 0.5) / n);
    const a = i * GOLD;
    const warp = 1 + a1 * Math.sin(a * h1 + p1) + a2 * Math.sin(a * h2 + p2);
    const r = 31 * f * warp;
    const cx = Math.cos(a) * r, cy = Math.sin(a) * r * squash;
    pts.push({
      x: CENTER + cx * Math.cos(tilt) - cy * Math.sin(tilt),
      y: CENTER + cx * Math.sin(tilt) + cy * Math.cos(tilt)
    });
  }
  return pts;
}

export const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = t => 1 - Math.pow(1 - t, 3);
