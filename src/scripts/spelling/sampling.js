import { HALF, CENTER } from './charmap.js';

let probeSvg = null, probePath = null;

// An offscreen SVG path element, used only for getTotalLength/getPointAtLength.
function probe() {
  if (probePath) return probePath;
  probeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  probeSvg.setAttribute('width', '0');
  probeSvg.setAttribute('height', '0');
  probeSvg.style.cssText = 'position:absolute;left:-9999px;top:0';
  probePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  probeSvg.appendChild(probePath);
  document.body.appendChild(probeSvg);
  return probePath;
}

const GOLD = Math.PI * (3 - Math.sqrt(5));

// Even-density sample of a glyph's skeleton into exactly n points. Points are
// distributed across sub-paths in proportion to arc length, so density is even.
// dotGrow (glyph units, 0 = off) pushes the fill of CIRCLE parts outwards. Only
// the grid engine passes it: its flat arc-union has no gradient tail, and a tail
// is what used to carry an isolated dot past the goo filter's alpha threshold.
// Strokes are unaffected — they are path parts, and their own dense overlap
// already reproduces the old edge. See UNION_R note in grid-engine.js.
export function samplePoints(parts, n, dotGrow = 0) {
  const pr = probe();
  const segs = [];
  let total = 0;
  parts.forEach(p => {
    if (p.t === 'c') {
      const len = Math.max(6, 2 * Math.PI * Math.max(p.r, 5));
      segs.push({ kind: 'c', p, len });
      total += len;
    } else {
      pr.setAttribute('d', p.d);
      let len = 0;
      try { len = pr.getTotalLength(); } catch (e) { len = 0; }
      if (len > 0.5) { segs.push({ kind: 'p', d: p.d, len }); total += len; }
    }
  });

  const pts = [];
  if (!total) {
    for (let i = 0; i < n; i++) pts.push({ x: CENTER, y: CENTER });
    return pts;
  }

  segs.forEach(s => {
    const count = Math.max(1, Math.round(n * s.len / total));
    if (s.kind === 'c') {
      // Fill the disc, don't outline it. Inset by HALF because the sprite radius
      // adds it back, so the union lands exactly on the true circle edge.
      const inner = Math.max(0, s.p.r - HALF + dotGrow);
      for (let i = 0; i < count; i++) {
        if (inner < 0.4) { pts.push({ x: s.p.cx, y: s.p.cy }); continue; }
        const rr = inner * Math.sqrt((i + 0.5) / count);
        const a = i * GOLD;
        pts.push({ x: s.p.cx + Math.cos(a) * rr, y: s.p.cy + Math.sin(a) * rr });
      }
    } else {
      pr.setAttribute('d', s.d);
      for (let i = 0; i < count; i++) {
        const q = pr.getPointAtLength(s.len * (count === 1 ? 0.5 : i / (count - 1)));
        pts.push({ x: q.x, y: q.y });
      }
    }
  });

  while (pts.length < n) {
    pts.push(Object.assign({}, pts[pts.length % Math.max(1, pts.length)] || { x: CENTER, y: CENTER }));
  }
  if (pts.length > n) pts.length = n;
  return pts;
}
