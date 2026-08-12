// Flatten every nested wrapper transform in a Morphics glyph SVG into absolute
// artboard coordinates, and return its drawable parts. Ported verbatim from
// Spelling.dc.html. Shapes are only <path> (M/L/A commands) and <circle>.
export function flatten(text) {
  const root = text.match(/<g filter="url\(#fillet\)">([\s\S]*)<\/g><\/svg>/);
  if (!root) return [];
  let inner = root[1], k = 1, tx = 0, ty = 0, m, guard = 0;
  const reS = /^\s*<g transform="translate\((-?[\d.]+)[\s,]+(-?[\d.]+)\)\s*scale\(([\d.]+)\)">([\s\S]*)<\/g>\s*$/;
  const reT = /^\s*<g transform="translate\((-?[\d.]+)[\s,]+(-?[\d.]+)\)">([\s\S]*)<\/g>\s*$/;
  const reP = /^\s*<g[^>]*>([\s\S]*)<\/g>\s*$/;
  while (guard++ < 8) {
    if ((m = inner.match(reS))) { tx += (+m[1]) * k; ty += (+m[2]) * k; k *= (+m[3]); inner = m[4]; continue; }
    if ((m = inner.match(reT))) { tx += (+m[1]) * k; ty += (+m[2]) * k; inner = m[3]; continue; }
    if ((m = inner.match(reP))) { inner = m[1]; continue; }
    break;
  }
  const out = [];
  const re = /<(path|circle)\b([^>]*)>/g;
  let t;
  while ((t = re.exec(inner))) {
    const at = n => { const a = t[2].match(new RegExp(n + '="([^"]*)"')); return a ? a[1] : null; };
    if (t[1] === 'circle') {
      out.push({ t: 'c', cx: +at('cx') * k + tx, cy: +at('cy') * k + ty, r: +at('r') * k });
    } else {
      const d = (at('d') || '')
        .replace(/A\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([01])[\s,]+([01])[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)/g,
          (s, rx, ry, r0, la, sw, x, y) =>
            'A ' + (+rx * k) + ' ' + (+ry * k) + ' ' + r0 + ' ' + la + ' ' + sw + ' ' + (+x * k + tx) + ' ' + (+y * k + ty))
        .replace(/([MLml])\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g,
          (s, c, x, y) => c + ' ' + (+x * k + tx) + ' ' + (+y * k + ty));
      out.push({ t: 'p', d });
    }
  }
  return out;
}
