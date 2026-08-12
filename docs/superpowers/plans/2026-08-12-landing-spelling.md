# Landing Page Spelling Animation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the Morphics *Spelling* metaball glyph engine on the landing page below the wordmark, looping `THE ONLY CONSTANT IS CHANGE` forever.

**Architecture:** The reference is one 900-line class in `Spelling.dc.html` that mixes pure geometry, a canvas render loop, and prototype UI. We split it into small pure modules under `src/scripts/spelling/` (charmap, parsing, shapes, pairing, layout, behaviours) plus one stateful `engine.js` that owns the canvas and rAF loop, mounted by a thin `Spelling.astro`. The pure modules get real unit tests; the render loop and glyph geometry get a headless-browser verification script, because `SVGPathElement.getTotalLength()` has no headless-DOM implementation.

**Tech Stack:** Astro 6, vanilla JS (no framework), Canvas 2D, CSS filters. Vitest for unit tests. `chrome-headless-shell` driven over CDP for visual verification (the pattern already used in this repo).

## Global Constraints

- **Source of truth is `~/Downloads/design_handoff_spelling/`.** `Spelling.dc.html` is the engine; `README.md` is the prose spec; `support.js` is scaffolding and is **never** ported.
- **Where README and code disagree, the code wins.** Specifically: the README claims a single-line phrase reveal at 112 units/char. The code stacks **one word per line** at `ADV = 92`, `LEAD = 100`. Build the code's behaviour.
- **Calibrated constants are load-bearing and must not be "improved":** `HALF = 6.5`; sprite radius `min(W,H) * 0.66 * (HALF/120) * 0.90`; sprite diameter `radius * 2.24`; gradient stops `1.0 / 1.0 @0.86 / 0.5 @0.94 / 0 @1.0`; `filter: blur(R * 0.71) contrast(26) brightness(1.03)`; pairing `SECTORS = 24`; idle re-target at `0.72 × duration`.
- **`dpr = 1` deliberately.** CSS filters apply at display scale; a larger backing store makes the blur act many times stronger and melts the form.
- **No prototype UI.** No header bar, no status readout, no phrase input, no preset chips, no behaviour lab, no `lockMode`, no `runTest`, no `renderVals`.
- **No changes to the wordmark, tagline copy, or ENTER button.** `index.astro` gains exactly one component.
- **Phrase is `THE ONLY CONSTANT IS CHANGE`**, defined once as a constant.
- **Node >= 22.12.0** (repo `engines` field). ESM only (`"type": "module"`).
- **No new runtime dependencies.** Vitest is `devDependencies` only and must not enter the client bundle.

---

### Task 1: Test harness and glyph assets

**Files:**
- Modify: `package.json` (add `devDependencies.vitest`, add `test` script)
- Create: `vitest.config.js`
- Create: `public/glyphs/svg/*.svg` (copied from the handoff)
- Create: `tests/spelling/assets.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` runs Vitest against `tests/**/*.test.js` in the `node` environment. Glyph SVGs are served at `/glyphs/svg/<id>.svg`.

- [ ] **Step 1: Copy the glyph assets**

```bash
cd /Users/morphics/Desktop/MorphicsBrain/website
mkdir -p public/glyphs/svg
cp ~/Downloads/design_handoff_spelling/glyphs/svg/*.svg public/glyphs/svg/
ls public/glyphs/svg | wc -l
```

Expected: 70+ files. Confirm `A.svg`, `num-0.svg`, and `sym-period.svg` are all present.

- [ ] **Step 2: Add Vitest**

```bash
npm install --save-dev vitest@^3
```

Then add to `package.json` `scripts`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create `vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
```

- [ ] **Step 4: Write the failing test**

Create `tests/spelling/assets.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../../public/glyphs/svg/', import.meta.url));

describe('glyph assets', () => {
  it('ships every letter of the tagline', () => {
    for (const ch of 'THEONLYCONSTANTISCHANGE') {
      expect(existsSync(dir + ch + '.svg'), ch + '.svg missing').toBe(true);
    }
  });

  it('uses a 120x120 viewBox with a fillet-filtered root group', () => {
    const svg = readFileSync(dir + 'A.svg', 'utf8');
    expect(svg).toContain('viewBox="0 0 120 120"');
    expect(svg).toContain('<g filter="url(#fillet)">');
  });
});
```

- [ ] **Step 5: Run it**

Run: `npm test`
Expected: PASS (assets were copied in Step 1). If the viewBox assertion fails, read an actual SVG and correct the assertion to match the real attribute — do not modify the SVGs.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.js public/glyphs tests/spelling/assets.test.js
git commit -m "test: add vitest harness and Morphics glyph assets"
```

---

### Task 2: Charmap and glyph parsing

**Files:**
- Create: `src/scripts/spelling/charmap.js`
- Create: `src/scripts/spelling/glyph-parse.js`
- Test: `tests/spelling/glyph-parse.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CHARMAP: Record<string, string>` — uppercase character → SVG basename (`'A' → 'A'`, `'0' → 'num-0'`, `'.' → 'sym-period'`).
  - `HALF: 6.5`
  - `PHRASE: 'THE ONLY CONSTANT IS CHANGE'`
  - `flatten(svgText: string): Part[]` where `Part` is `{ t: 'p', d: string }` or `{ t: 'c', cx: number, cy: number, r: number }`.

- [ ] **Step 1: Write the failing test**

Create `tests/spelling/glyph-parse.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHARMAP, HALF, PHRASE } from '../../src/scripts/spelling/charmap.js';
import { flatten } from '../../src/scripts/spelling/glyph-parse.js';

const dir = fileURLToPath(new URL('../../public/glyphs/svg/', import.meta.url));

describe('CHARMAP', () => {
  it('maps letters to themselves, digits to num-, symbols to sym-', () => {
    expect(CHARMAP['A']).toBe('A');
    expect(CHARMAP['Z']).toBe('Z');
    expect(CHARMAP['0']).toBe('num-0');
    expect(CHARMAP['7']).toBe('num-7');
    expect(CHARMAP['.']).toBe('sym-period');
    expect(CHARMAP['&']).toBe('sym-ampersand');
  });

  it('has no entry for space, so spaces are handled by the sequencer', () => {
    expect(CHARMAP[' ']).toBeUndefined();
  });

  it('exposes the load-bearing half-stroke and the landing phrase', () => {
    expect(HALF).toBe(6.5);
    expect(PHRASE).toBe('THE ONLY CONSTANT IS CHANGE');
  });
});

describe('flatten', () => {
  it('returns drawable parts for every tagline glyph', () => {
    for (const ch of new Set('THEONLYCONSTANTISCHANGE')) {
      const parts = flatten(readFileSync(dir + ch + '.svg', 'utf8'));
      expect(parts.length, ch + ' produced no parts').toBeGreaterThan(0);
      for (const p of parts) expect(['p', 'c']).toContain(p.t);
    }
  });

  it('bakes wrapper transforms into absolute coordinates inside the artboard', () => {
    const parts = flatten(readFileSync(dir + 'I.svg', 'utf8'));
    const nums = parts.flatMap(p =>
      p.t === 'c' ? [p.cx, p.cy] : (p.d.match(/-?[\d.]+/g) || []).map(Number)
    );
    expect(nums.length).toBeGreaterThan(0);
    for (const n of nums) {
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThan(-200);
      expect(n).toBeLessThan(320);
    }
  });

  it('returns an empty array when the root group is absent', () => {
    expect(flatten('<svg></svg>')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/spelling/glyph-parse.test.js`
Expected: FAIL — `Failed to resolve import ".../charmap.js"`

- [ ] **Step 3: Create `src/scripts/spelling/charmap.js`**

Port `CHARMAP` verbatim from `Spelling.dc.html` lines 83–97 and `HALF` from line 98, converted to named exports:

```js
// The Morphics constructed alphabet: character -> SVG basename in /glyphs/svg/.
// Ported verbatim from Spelling.dc.html (the design handoff). Unmapped characters
// are skipped by the sequencer, never substituted.
export const CHARMAP = (() => {
  const m = {};
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach(c => { m[c] = c; });
  '0123456789'.split('').forEach((c, i) => { m[c] = 'num-' + i; });
  const sym = {
    '.': 'period', ',': 'comma', ':': 'colon', ';': 'semicolon', '!': 'exclam', '?': 'question',
    "'": 'apostrophe', '"': 'quote', '`': 'backtick', '-': 'hyphen', '_': 'underscore', '/': 'slash',
    '\\': 'backslash', '|': 'pipe', '(': 'paren-open', ')': 'paren-close', '[': 'bracket-open',
    ']': 'bracket-close', '{': 'brace-open', '}': 'brace-close', '<': 'less', '>': 'greater',
    '+': 'plus', '=': 'equals', '*': 'asterisk', '#': 'hash', '%': 'percent', '@': 'at', '&': 'ampersand',
    '^': 'caret', '~': 'tilde', '$': 'dollar', '£': 'pound', '€': 'euro', '¥': 'yen',
    '°': 'degree', '·': 'bullet'
  };
  Object.keys(sym).forEach(k => { m[k] = 'sym-' + sym[k]; });
  return m;
})();

// Half the 13-unit house stroke, in the 120x120 glyph artboard's units.
export const HALF = 6.5;

// Everything lives on a 120x120 artboard whose centre is (60, 60).
export const CENTER = 60;

export const PHRASE = 'THE ONLY CONSTANT IS CHANGE';
```

- [ ] **Step 4: Create `src/scripts/spelling/glyph-parse.js`**

Port `flatten` verbatim from `Spelling.dc.html` lines 113–146. Add the export keyword and the header comment; change nothing else — the regexes and the `guard < 8` loop bound are exactly as shipped.

```js
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
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- tests/spelling/glyph-parse.test.js`
Expected: PASS, all 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/spelling/charmap.js src/scripts/spelling/glyph-parse.js tests/spelling/glyph-parse.test.js
git commit -m "feat(spelling): port charmap and glyph SVG flattening"
```

---

### Task 3: Shapes, easing, pairing and bounding box

**Files:**
- Create: `src/scripts/spelling/shapes.js`
- Create: `src/scripts/spelling/pairing.js`
- Test: `tests/spelling/shapes.test.js`
- Test: `tests/spelling/pairing.test.js`

**Interfaces:**
- Consumes: `CENTER` from `charmap.js`.
- Produces:
  - `spherePoints(n): {x,y}[]` — golden-angle disc of radius 30 about (60,60).
  - `blobShape(n): {x,y}[]` — formless low-harmonic mass, random each call.
  - `ease(t): number` — cubic in-out.
  - `easeOut(t): number` — cubic out.
  - `assign(src, dst): {x,y}[]` — `dst` reordered so `out[i]` is the target for `src[i]`.
  - `box(pts): {cx, cy, w, h}` — `w`/`h` are never 0 (floored at 1).

- [ ] **Step 1: Write the failing tests**

Create `tests/spelling/shapes.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { spherePoints, blobShape, ease, easeOut } from '../../src/scripts/spelling/shapes.js';

const radius = p => Math.hypot(p.x - 60, p.y - 60);

describe('spherePoints', () => {
  it('returns exactly n points inside radius 30 of the artboard centre', () => {
    const pts = spherePoints(500);
    expect(pts).toHaveLength(500);
    for (const p of pts) expect(radius(p)).toBeLessThanOrEqual(30.0001);
  });

  it('fills the disc rather than outlining it', () => {
    const pts = spherePoints(500);
    const inner = pts.filter(p => radius(p) < 15).length;
    expect(inner).toBeGreaterThan(80);
  });
});

describe('blobShape', () => {
  it('returns exactly n points and never the same mass twice', () => {
    const a = blobShape(420), b = blobShape(420);
    expect(a).toHaveLength(420);
    expect(b).toHaveLength(420);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('stays a soft mass — every point well inside the artboard', () => {
    for (let run = 0; run < 20; run++) {
      for (const p of blobShape(420)) {
        expect(radius(p)).toBeLessThan(50);
      }
    }
  });
});

describe('easing', () => {
  it('pins both ends', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
  });

  it('is monotonic', () => {
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const v = ease(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('is symmetric about the midpoint', () => {
    expect(ease(0.5)).toBeCloseTo(0.5, 6);
    expect(ease(0.25) + ease(0.75)).toBeCloseTo(1, 6);
  });
});
```

Create `tests/spelling/pairing.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { assign, box } from '../../src/scripts/spelling/pairing.js';

const ring = (n, r, phase = 0) =>
  Array.from({ length: n }, (_, i) => {
    const a = phase + (i / n) * Math.PI * 2;
    return { x: 60 + Math.cos(a) * r, y: 60 + Math.sin(a) * r };
  });

describe('assign', () => {
  it('returns one target per source and uses every target exactly once', () => {
    const src = ring(96, 20), dst = ring(96, 34, 0.7);
    const out = assign(src, dst);
    expect(out).toHaveLength(96);
    expect(new Set(out).size).toBe(96);
    for (const p of out) expect(dst).toContain(p);
  });

  it('keeps points in their own angular sector, so none crosses the centre', () => {
    const src = ring(240, 20), dst = ring(240, 30);
    const out = assign(src, dst);
    for (let i = 0; i < src.length; i++) {
      const a0 = Math.atan2(src[i].y - 60, src[i].x - 60);
      const a1 = Math.atan2(out[i].y - 60, out[i].x - 60);
      let d = Math.abs(a1 - a0);
      if (d > Math.PI) d = Math.PI * 2 - d;
      // 24 sectors is 15 degrees each; allow one sector of slack.
      expect(d).toBeLessThan((Math.PI * 2) / 24 + 0.01);
    }
  });

  it('pairs by radius within a sector, so an inner ring maps to an inner ring', () => {
    const src = [...ring(24, 10), ...ring(24, 40)];
    const dst = [...ring(24, 12), ...ring(24, 44)];
    const out = assign(src, dst);
    for (let i = 0; i < 24; i++) {
      expect(Math.hypot(out[i].x - 60, out[i].y - 60)).toBeLessThan(20);
    }
  });
});

describe('box', () => {
  it('measures centre and extent', () => {
    const b = box([{ x: 40, y: 50 }, { x: 80, y: 70 }]);
    expect(b.cx).toBe(60);
    expect(b.cy).toBe(60);
    expect(b.w).toBe(40);
    expect(b.h).toBe(20);
  });

  it('never reports a zero dimension, so the framing lock cannot divide by zero', () => {
    const b = box([{ x: 60, y: 60 }, { x: 60, y: 60 }]);
    expect(b.w).toBe(1);
    expect(b.h).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/spelling/shapes.test.js tests/spelling/pairing.test.js`
Expected: FAIL — cannot resolve `shapes.js` / `pairing.js`.

- [ ] **Step 3: Create `src/scripts/spelling/shapes.js`**

`spherePoints` is verbatim from `Spelling.dc.html` lines 190–200; `blobShape` from 227–245 (dropping its unused `t` parameter); `ease`/`easeOut` from 246–247.

```js
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
```

- [ ] **Step 4: Create `src/scripts/spelling/pairing.js`**

`assign` is verbatim from `Spelling.dc.html` lines 202–214; `box` from the static method at lines 365–373.

```js
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
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- tests/spelling/shapes.test.js tests/spelling/pairing.test.js`
Expected: PASS, all 10 tests.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/spelling/shapes.js src/scripts/spelling/pairing.js tests/spelling/shapes.test.js tests/spelling/pairing.test.js
git commit -m "feat(spelling): port shapes, easing, sector pairing and bounding box"
```

---

### Task 4: Phrase layout planner

Extracted from `phrasePoints` (`Spelling.dc.html` lines 311–339) so the layout arithmetic is testable without a DOM. The planner decides *where each glyph goes*; Task 6's engine fills those slots with sampled points.

**Files:**
- Create: `src/scripts/spelling/layout.js`
- Test: `tests/spelling/layout.test.js`

**Interfaces:**
- Consumes: `CHARMAP`, `CENTER` from `charmap.js`.
- Produces:
  - `planPhrase(text: string, budget: number): Plan | null`
  - `Plan = { lines: string[][], scale: number, perGlyph: number, slots: Slot[] }`
  - `Slot = { ch: string, cx: number, cy: number }` — artboard coordinates of that glyph's centre.
  - `viewScaleFor(span, canvasW, canvasH, Rpx): number`

- [ ] **Step 1: Write the failing test**

Create `tests/spelling/layout.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { planPhrase, viewScaleFor } from '../../src/scripts/spelling/layout.js';
import { PHRASE } from '../../src/scripts/spelling/charmap.js';

describe('planPhrase', () => {
  it('puts one word on each line and never breaks a word', () => {
    const plan = planPhrase(PHRASE, 7200);
    expect(plan.lines.map(l => l.join(''))).toEqual(
      ['THE', 'ONLY', 'CONSTANT', 'IS', 'CHANGE']
    );
  });

  it('emits one slot per glyph, in reading order', () => {
    const plan = planPhrase(PHRASE, 7200);
    expect(plan.slots).toHaveLength(23);
    expect(plan.slots.map(s => s.ch).join('')).toBe('THEONLYCONSTANTISCHANGE');
  });

  it('centres each line horizontally and the block vertically', () => {
    const plan = planPhrase('AB CDEF', 7200);
    const [l0, l1] = [plan.slots.slice(0, 2), plan.slots.slice(2)];
    const mid = s => (s[0].cx + s[s.length - 1].cx) / 2;
    expect(mid(l0)).toBeCloseTo(mid(l1), 6);
    const ys = [...new Set(plan.slots.map(s => s.cy))];
    expect(ys).toHaveLength(2);
    expect((ys[0] + ys[1]) / 2).toBeCloseTo(60, 6);
  });

  it('shrinks the scale as the phrase grows, and never exceeds 0.72', () => {
    const short = planPhrase('AB', 7200).scale;
    const long = planPhrase(PHRASE, 7200).scale;
    expect(short).toBeLessThanOrEqual(0.72);
    expect(long).toBeLessThan(short);
  });

  it('clamps the per-glyph point budget to 360..760', () => {
    expect(planPhrase(PHRASE, 100).perGlyph).toBe(360);
    expect(planPhrase(PHRASE, 1e6).perGlyph).toBe(760);
    expect(planPhrase(PHRASE, 7200).perGlyph).toBe(Math.floor(7200 / 23));
  });

  it('uppercases input and drops unmapped characters', () => {
    const plan = planPhrase('a§b', 7200);
    expect(plan.slots.map(s => s.ch).join('')).toBe('AB');
  });

  it('returns null when nothing is mappable', () => {
    expect(planPhrase('   ', 7200)).toBeNull();
    expect(planPhrase('§§', 7200)).toBeNull();
  });
});

describe('viewScaleFor', () => {
  it('opens the view so the laid-out block fills the canvas', () => {
    const wide = viewScaleFor(40, 430, 430, 14);
    const narrow = viewScaleFor(120, 430, 430, 14);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('clamps to 0.6..2.6 so no phrase length can blow out the framing', () => {
    expect(viewScaleFor(1, 430, 430, 14)).toBeLessThanOrEqual(2.6);
    expect(viewScaleFor(100000, 430, 430, 14)).toBeGreaterThanOrEqual(0.6);
  });

  it('scales with the canvas, so a smaller canvas still fits the phrase', () => {
    expect(viewScaleFor(60, 300, 300, 14)).toBeGreaterThan(0);
    expect(viewScaleFor(60, 300, 300, 14)).toBeLessThanOrEqual(2.6);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/spelling/layout.test.js`
Expected: FAIL — cannot resolve `layout.js`.

- [ ] **Step 3: Create `src/scripts/spelling/layout.js`**

The arithmetic below is lifted from `phrasePoints`; only the point sampling is deferred to the caller.

```js
import { CHARMAP, CENTER } from './charmap.js';

// A word never breaks — one line per word, however long it is.
const ADV = 92;    // horizontal advance per glyph, artboard units
const LEAD = 100;  // line-to-line advance, artboard units

// Lay a phrase out as stacked word-lines and return each glyph's centre in
// artboard coordinates. Scale auto-fits the 120x120 artboard, so a phrase of any
// length lands inside it; viewScaleFor then opens the view to reclaim the margin.
export function planPhrase(text, budget) {
  const lines = String(text).toUpperCase().split(' ')
    .map(w => w.split('').filter(c => CHARMAP[c]))
    .filter(l => l.length);
  if (!lines.length) return null;

  const longest = Math.max(...lines.map(l => l.length));
  const rows = lines.length;
  const scale = Math.min(0.72, 120 / (longest * ADV), 110 / (rows * LEAD));

  const total = lines.reduce((a, l) => a + l.length, 0);
  const perGlyph = Math.max(360, Math.min(760, Math.floor(budget / total)));

  const slots = [];
  for (let r = 0; r < rows; r++) {
    const line = lines[r];
    const lineW = line.length * ADV - (ADV - 80);
    const x0 = CENTER - (lineW * scale) / 2;
    const cy = CENTER + (r - (rows - 1) / 2) * LEAD * scale;
    for (let c = 0; c < line.length; c++) {
      slots.push({ ch: line[c], cx: x0 + (c * ADV + 40) * scale, cy });
    }
  }
  return { lines, scale, perGlyph, slots };
}

// Derive the view scale from the MEASURED canvas, not a constant, so a phrase of
// any length is guaranteed to fit the raster instead of being sliced by it.
// `span` is the laid-out field's largest dimension in artboard units, plus stroke.
export function viewScaleFor(span, canvasW, canvasH, Rpx) {
  const minDim = Math.min(canvasW, canvasH);
  const half = (span / 2) / 120 * minDim * 0.66;
  return Math.max(0.6, Math.min(2.6, (minDim / 2 - Rpx - 8) / Math.max(1, half)));
}

export { ADV, LEAD };
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/spelling/layout.test.js`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/spelling/layout.js tests/spelling/layout.test.js
git commit -m "feat(spelling): extract testable phrase layout planner"
```

---

### Task 5: Behaviour displacement table

The reference has this as a 130-line `if/else` chain inside the render loop. Extracting it to a pure function makes all 25 behaviours testable and keeps `engine.js` readable.

**Files:**
- Create: `src/scripts/spelling/behaviours.js`
- Test: `tests/spelling/behaviours.test.js`

**Interfaces:**
- Consumes: `ease`, `easeOut` from `shapes.js`; `CENTER` from `charmap.js`.
- Produces:
  - `MODES: string[]` — the 25 behaviour names.
  - `IDLE_MODE: 'direct'`
  - `leadFor(mode, target, index, n, seed): number` — per-particle stagger, 0..~0.5.
  - `displace(mode, a, b, tt, i, seed, now): {x, y}` — `a` source point, `b` target point, `tt` staggered progress 0..1.
  - `pickMode(previous): string` — random, never equal to `previous`.

- [ ] **Step 1: Write the failing test**

Create `tests/spelling/behaviours.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { MODES, IDLE_MODE, displace, leadFor, pickMode } from '../../src/scripts/spelling/behaviours.js';

const A = { x: 30, y: 45 };
const B = { x: 88, y: 72 };

describe('MODES', () => {
  it('has the full behaviour set and no duplicates', () => {
    expect(MODES).toHaveLength(25);
    expect(new Set(MODES).size).toBe(25);
    expect(MODES).toContain('direct');
    expect(MODES).toContain('magnet');
    expect(IDLE_MODE).toBe('direct');
  });
});

describe('displace', () => {
  it('lands exactly on the target at tt=1 for every behaviour', () => {
    for (const m of MODES) {
      const p = displace(m, A, B, 1, 0, 0.5, 1000);
      expect(p.x, m + ' missed x').toBeCloseTo(B.x, 6);
      expect(p.y, m + ' missed y').toBeCloseTo(B.y, 6);
    }
  });

  it('starts at the source at tt=0, or a rotation of it', () => {
    // These five rotate (and unwind additionally shrinks) the SOURCE at tt=0
    // before unwinding into the target, so they do not begin at `a`. What must
    // hold is that none of them starts OUTSIDE the source radius — every
    // behaviour is volume-preserving, and a t=0 swell would read as a size pop.
    const rotators = ['swirl', 'orbit', 'unwind', 'vortex', 'furl'];
    const rA = Math.hypot(A.x - 60, A.y - 60);
    for (const m of MODES) {
      const p = displace(m, A, B, 0, 0, 0.5, 1000);
      if (rotators.includes(m)) {
        const r = Math.hypot(p.x - 60, p.y - 60);
        expect(r, m + ' swelled at t=0').toBeLessThanOrEqual(rA + 1e-6);
        expect(r, m + ' collapsed at t=0').toBeGreaterThan(rA * 0.4);
      } else {
        expect(p.x, m + ' moved x at t=0').toBeCloseTo(A.x, 6);
        expect(p.y, m + ' moved y at t=0').toBeCloseTo(A.y, 6);
      }
    }
  });

  it('peaks mid-transition rather than sliding, for the displacing behaviours', () => {
    const straight = (t) => ({
      x: A.x + (B.x - A.x) * t,
      y: A.y + (B.y - A.y) * t
    });
    for (const m of ['implode', 'split', 'shear', 'fold', 'lathe', 'seam', 'quench', 'inhale', 'peel']) {
      const mid = displace(m, A, B, 0.5, 0, 0.5, 1000);
      const line = straight(0.5);
      expect(Math.hypot(mid.x - line.x, mid.y - line.y), m + ' did not depart the line').toBeGreaterThan(1);
    }
  });

  it('never sends a point outside a sane artboard neighbourhood', () => {
    for (const m of MODES) {
      for (let tt = 0; tt <= 1.0001; tt += 0.05) {
        const p = displace(m, A, B, tt, 3, 0.31, 5000);
        expect(Number.isFinite(p.x) && Number.isFinite(p.y), m).toBe(true);
        expect(Math.abs(p.x - 60), m + ' x blew out').toBeLessThan(160);
        expect(Math.abs(p.y - 60), m + ' y blew out').toBeLessThan(160);
      }
    }
  });

  it('falls back to plain interpolation for an unknown behaviour', () => {
    const p = displace('nonesuch', A, B, 0.5, 0, 0.5, 1000);
    const q = displace('direct', A, B, 0.5, 0, 0.5, 1000);
    expect(p).toEqual(q);
  });
});

describe('leadFor', () => {
  it('staggers only the staggering behaviours, and stays under 1', () => {
    const staggered = ['wave', 'ripple', 'seam', 'knit', 'boil', 'split', 'cascade', 'snake'];
    for (const m of MODES) {
      const lead = leadFor(m, B, 5, 100, 0.5);
      expect(lead).toBeGreaterThanOrEqual(0);
      expect(lead).toBeLessThan(1);
      if (!staggered.includes(m)) expect(lead, m).toBe(0);
    }
    expect(leadFor('snake', B, 50, 100, 0.5)).toBeCloseTo(0.25, 6);
  });
});

describe('pickMode', () => {
  it('never repeats the previous behaviour back to back', () => {
    let prev = 'direct';
    for (let i = 0; i < 500; i++) {
      const next = pickMode(prev);
      expect(MODES).toContain(next);
      expect(next).not.toBe(prev);
      prev = next;
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/spelling/behaviours.test.js`
Expected: FAIL — cannot resolve `behaviours.js`.

- [ ] **Step 3: Create `src/scripts/spelling/behaviours.js`**

Transcribe `MODES` (lines 216–224), the `lead` chain (lines 500–517) and the behaviour `if/else` chain (lines 519–637) from `Spelling.dc.html`. Every formula is unchanged; only the surrounding structure differs — `this.mode` becomes the `mode` argument, `this.n` becomes `n`, `sd` becomes `seed`.

```js
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
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- tests/spelling/behaviours.test.js`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, all files green.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/spelling/behaviours.js tests/spelling/behaviours.test.js
git commit -m "feat(spelling): extract the 25 morph behaviours as a pure table"
```

---

### Task 6: The engine

The stateful half: glyph fetching and sampling, the rAF loop, the sprite, the framing lock, the flow field, and the looping sequencer. `samplePoints` needs a live `SVGPathElement`, so this task's verification is a smoke test in a real browser (Task 8 does the rigorous measurement).

**Files:**
- Create: `src/scripts/spelling/sampling.js`
- Create: `src/scripts/spelling/engine.js`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces:
  - `samplePoints(parts, n): {x,y}[]` — exactly `n` points, evenly dense across sub-paths.
  - `class SpellingEngine { constructor(canvas, opts); start(); stop(); destroy(); }`
  - `opts = { phrase = PHRASE, letterPoints = 900, maxPoints = 7200, idlePoints = 420, morphMs = 620, holdMs = 380, restMs = 2000, glyphBase = '/glyphs/svg/' }`

- [ ] **Step 1: Create `src/scripts/spelling/sampling.js`**

`probe` is verbatim from `Spelling.dc.html` lines 100–112; `samplePoints` from lines 147–188.

```js
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
export function samplePoints(parts, n) {
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
      const inner = Math.max(0, s.p.r - HALF);
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
```

- [ ] **Step 2: Create `src/scripts/spelling/engine.js`**

Port the `Component` class from `Spelling.dc.html`, dropping `state`/`setState`, `renderVals`, `runTest`, `lockMode`, `stop`'s UI concerns, and the resize/zoom handling. Methods `size`, `parts`, `glyph`, `resize`, `morphTo`, `idleTick`, `makeSprite`, `frame` are ported from lines 282–789; `phrasePoints` is rebuilt on top of Task 4's planner; `run` becomes the looping `cycle`.

```js
import { CHARMAP, CENTER, HALF, PHRASE } from './charmap.js';
import { flatten } from './glyph-parse.js';
import { samplePoints } from './sampling.js';
import { spherePoints, blobShape, ease } from './shapes.js';
import { assign, box } from './pairing.js';
import { planPhrase, viewScaleFor } from './layout.js';
import { IDLE_MODE, displace, leadFor, pickMode } from './behaviours.js';

const clone = p => ({ x: p.x, y: p.y });

export class SpellingEngine {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.phrase = opts.phrase ?? PHRASE;
    this.N_LETTER = opts.letterPoints ?? 900;
    this.N_MAX = opts.maxPoints ?? 7200;
    this.N_IDLE = opts.idlePoints ?? 420;
    this.morphMs = opts.morphMs ?? 620;
    this.holdMs = opts.holdMs ?? 380;
    this.restMs = opts.restMs ?? 2000;
    this.glyphBase = opts.glyphBase ?? '/glyphs/svg/';

    this.cache = {};
    this.n = this.N_LETTER;
    this.cur = spherePoints(this.n);
    this.from = this.cur.map(clone);
    this.to = this.cur.map(clone);
    this.seed = this.cur.map(() => Math.random());
    this.t0 = performance.now();
    this.dur = 1;
    this.mode = 'direct';
    this.dpr = 1;
    this.running = false;   // true while spelling; false while dormant
    this.stopped = true;    // true when the loop must unwind
    this.raf = null;
    this.timer = null;
  }

  // ---- lifecycle ---------------------------------------------------------

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.size();
    if (this.raf === null) this.raf = requestAnimationFrame(this.frame);
    this.cycle();
  }

  stop() {
    this.stopped = true;
    this.running = false;
    clearTimeout(this.timer);
    if (this.raf !== null) { cancelAnimationFrame(this.raf); this.raf = null; }
  }

  destroy() {
    this.stop();
    this.cache = {};
    this.PX = this.PY = this.BX = this.BY = null;
  }

  wait(ms) {
    return new Promise(r => { this.timer = setTimeout(r, ms); });
  }

  // ---- geometry ----------------------------------------------------------

  // The filter cost scales with pixel area and CSS filters apply at DISPLAY
  // scale, so dpr stays 1: a backing store larger than the layout box makes the
  // blur act many times stronger and melts the form.
  size() {
    const c = this.canvas;
    if (!c || !c.clientWidth) return;
    const w = Math.floor(c.clientWidth * this.dpr);
    const h = Math.floor(c.clientHeight * this.dpr);
    // Assigning width/height clears the backing store — only do it on a change,
    // or every resize blanks a frame.
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }

  async parts(ch) {
    const id = CHARMAP[ch.toUpperCase()];
    if (!id) return null;
    if (this.cache[id]) return this.cache[id];
    try {
      const txt = await fetch(this.glyphBase + id + '.svg').then(r => r.text());
      this.cache[id] = flatten(txt);
      return this.cache[id];
    } catch (e) {
      return null;
    }
  }

  async glyph(ch, n) {
    const p = await this.parts(ch);
    return p ? samplePoints(p, n || this.n) : null;
  }

  // Lay the whole phrase out as one field of points — words stack as lines.
  async phrasePoints(text, budget) {
    const plan = planPhrase(text, budget);
    if (!plan) return null;
    const out = [];
    for (const slot of plan.slots) {
      const pts = await this.glyph(slot.ch, plan.perGlyph);
      if (!pts) continue;
      for (const p of pts) {
        out.push({
          x: slot.cx + (p.x - CENTER) * plan.scale,
          y: slot.cy + (p.y - CENTER) * plan.scale
        });
      }
    }
    if (!out.length) return null;
    const b = box(out);
    return { pts: out, scale: plan.scale, span: Math.max(b.w, b.h) + 13 };
  }

  // Grow or shrink the particle field, carrying the current shape across.
  // Seeds stay tied to position so the flow field doesn't discontinuously
  // re-roll and make the whole surface flash.
  resize(n) {
    if (n === this.n) return;
    const src = this.cur, sd = this.seed, m = src.length;
    const next = [], seeds = [];
    for (let i = 0; i < n; i++) {
      const j = Math.floor(i * m / n);
      next.push(clone(src[j]));
      seeds.push(sd && sd[j] !== undefined ? sd[j] : Math.random());
    }
    this.cur = next;
    this.from = next.map(clone);
    this.to = next.map(clone);
    this.seed = seeds;
    this.n = n;
    // Keep the framing valid against the resampled field — nulling it switches
    // the correction off for a frame and lets the form expand past the canvas.
    const bb = box(this.cur);
    this.bbFrom = bb;
    this.bbTo = bb;
    this.rFrom = this.rTo = this.rScale === undefined ? 1 : this.rScale;
    this.vFrom = this.vTo = this.vScale === undefined ? 1 : this.vScale;
  }

  morphTo(pts, mode, dur, rs, vs) {
    this.rFrom = this.rScale === undefined ? 1 : this.rScale;
    this.vFrom = this.vScale === undefined ? 1 : this.vScale;
    this.rTo = rs === undefined ? 1 : rs;
    this.vTo = vs === undefined ? 1 : vs;
    this.RFrom = this.Rpx;   // continue from the radius actually on screen
    this.from = this.cur.map(clone);
    this.to = assign(this.from, pts);
    if (!this.seed || this.seed.length !== this.n) {
      this.seed = new Array(this.n).fill(0).map(() => Math.random());
    }
    // Chain clean target boxes, not displaced ones.
    this.bbFrom = this.bbTo || box(this.from);
    this.bbTo = box(this.to);
    this.mode = mode || pickMode(this.mode);
    this.t0 = performance.now();
    this.dur = dur || this.morphMs;
    this.nextIdle = this.t0 + this.dur;
    this.frozen = false;
    this.calmIn = false;
    this.calmOut = false;
  }

  // Dormant: keep flowing between formless masses, never settle.
  idleTick(now) {
    if (this.running || this.stopped || now < (this.nextIdle || 0)) return;
    this.resize(this.N_IDLE);
    const dur = 2200 + Math.random() * 1600;
    this.morphTo(blobShape(this.n), IDLE_MODE, dur);
    // Re-target before the last one lands, so shapes cross-fade and never arrive.
    this.nextIdle = now + dur * 0.72;
  }

  // ---- the loop ----------------------------------------------------------

  // The reference's run() executes once. This repeats it forever.
  async cycle() {
    while (!this.stopped) {
      await this.spellOnce();
      if (this.stopped) return;
      await this.wait(this.restMs);
    }
  }

  async spellOnce() {
    this.running = true;
    const chars = this.phrase.toUpperCase().split('');
    let last = null;

    for (const ch of chars) {
      if (this.stopped) break;
      if (ch === ' ') {
        this.resize(this.N_LETTER);
        this.morphTo(spherePoints(this.n), 'implode');
        await this.wait(this.morphMs + 120);
        continue;
      }
      this.resize(this.N_LETTER);
      const pts = await this.glyph(ch);
      if (!pts) continue;
      last = pickMode(last);
      this.morphTo(pts, last);
      await this.wait(this.morphMs + this.holdMs);
    }

    // The whole phrase resolves out of the last letter, seamlessly.
    let exiting = false;
    const mapped = chars.filter(c => CHARMAP[c]).length;
    if (!this.stopped && mapped > 1) {
      const budget = Math.min(this.N_MAX, Math.max(this.N_LETTER, 700 * mapped));
      const w = await this.phrasePoints(this.phrase, budget);
      if (w && !this.stopped) {
        this.resize(w.pts.length);
        const c = this.canvas;
        const CW = c ? c.width : 430, CH = c ? c.height : 430;
        const vs = viewScaleFor(w.span, CW, CH, this.Rpx || 14);
        const inMs = Math.round(this.morphMs * 1.5);
        // The phrase is the letters uniformly rescaled — the stroke rides the
        // same scale as the geometry, so weight stays modular at any length.
        this.morphTo(w.pts, 'direct', inMs, w.scale, vs);
        this.calmIn = true;
        await this.wait(inMs);
        this.calmIn = false;
        this.t0 = performance.now() - this.dur - 1;   // land the morph exactly
        this.frozen = true;
        await this.wait(this.holdMs * 4);
        this.frozen = false;
        exiting = true;
      }
    }

    // Return to dormant. This return is itself a morph and must stay inside the
    // framing lock; releasing it early doubles the ink and pins the mass to the
    // canvas edges.
    this.running = false;
    if (this.stopped) return;
    const tail = Math.round(this.morphMs * (exiting ? 1.9 : 1.6));
    this.resize(this.N_IDLE);
    this.morphTo(blobShape(this.N_IDLE), 'direct', tail, 1, 1);
    this.calmOut = exiting;
    this.nextIdle = performance.now() + tail;
    await this.wait(tail);
  }

  // ---- render ------------------------------------------------------------

  // One pre-rendered blob, blitted per particle — a hard core with a short tail,
  // so blur+contrast thresholds right at the true stroke edge. A long gradient
  // tail sums to full white far past the core under additive blending, so the
  // threshold lands outside the intended edge and every stroke renders fat.
  makeSprite(D) {
    const pad = Math.max(4, Math.round(D / 2));
    const s = document.createElement('canvas');
    s.width = s.height = pad * 2;
    const g2 = s.getContext('2d');
    const g = g2.createRadialGradient(pad, pad, 0, pad, pad, pad);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.86, 'rgba(255,255,255,1)');
    g.addColorStop(0.94, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    g2.fillStyle = g;
    g2.fillRect(0, 0, pad * 2, pad * 2);
    this.sprite = s;
    this.spriteD = pad * 2;
  }

  frame = (now) => {
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden) return;
    // Cap the sim at ~48fps — the form is fluid, not twitchy, and this halves
    // the filter cost.
    if (this.lastF && now - this.lastF < 20) return;
    this.lastF = now;

    const c = this.canvas;
    if (!c || !c.isConnected || !c.clientWidth) return;
    if (!c.width || c.width !== Math.floor(c.clientWidth * this.dpr)) this.size();

    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    const vf = this.vFrom === undefined ? 1 : this.vFrom;
    const vt = this.vTo === undefined ? 1 : this.vTo;
    this.vScale = vf + (vt - vf) * ease(Math.min(1, (now - this.t0) / this.dur));
    const S = Math.min(W, H) * 0.66 * this.vScale;
    const ox = W / 2, oy = H / 2;

    this.idleTick(now);
    const raw = Math.min(1, (now - this.t0) / this.dur);

    if (this.frozen) { if (this.freezeAt === undefined) this.freezeAt = now; }
    else this.freezeAt = undefined;
    const bt = this.freezeAt === undefined ? now : this.freezeAt;
    const breathe = 1 + Math.sin(bt / 1400) * 0.012;
    const bobY = Math.sin(bt / 1900) * S * 0.012;
    const bobX = Math.cos(bt / 2600) * S * 0.008;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    // Interpolate the RENDERED radius, not its two factors — S already carries
    // vScale, so scaling by rScale on top double-counts and steps at re-target.
    const eR = ease(raw);
    const rf = this.rFrom === undefined ? 1 : this.rFrom;
    const rt = this.rTo === undefined ? 1 : this.rTo;
    const S0 = Math.min(W, H) * 0.66 * (HALF / 120) * 0.90;
    const RTo = S0 * vt * rt;
    if (this.RFrom === undefined) this.RFrom = RTo;
    const R = this.RFrom + (RTo - this.RFrom) * eR;
    this.Rpx = R;
    this.rScale = rf + (rt - rf) * eR;

    // The threshold must land at the same fraction of the stroke at every scale,
    // so drive the blur from the rendered radius and hold contrast constant.
    const flt = 'blur(' + (R * 0.71).toFixed(2) + 'px) contrast(26) brightness(1.03)';
    if (this.fltNow !== flt) { c.style.filter = flt; this.fltNow = flt; }

    const settle = this.running ? raw * raw : 0;

    if (!this.PX || this.PX.length < this.n) {
      this.PX = new Float32Array(this.n); this.PY = new Float32Array(this.n);
      this.BX = new Float32Array(this.n); this.BY = new Float32Array(this.n);
    }
    const PX = this.PX, PY = this.PY, BX = this.BX, BY = this.BY;
    let nx0 = 1e9, ny0 = 1e9, nx1 = -1e9, ny1 = -1e9;

    const D = R * 2.24;
    if (!this.sprite || Math.abs(this.spriteD - D) > 1) this.makeSprite(D);
    const sp = this.sprite, SD = this.spriteD;
    ctx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < this.n; i++) {
      const a = this.from[i], b = this.to[i], sd = this.seed[i];
      const lead = leadFor(this.mode, b, i, this.n, sd);
      const tt = Math.max(0, Math.min(1, (raw - lead) / (1 - lead || 1)));
      const d = displace(this.mode, a, b, tt, i, sd, now);
      let x = d.x, y = d.y;

      // Surface noise lives only while in transit, so a settled letter is exact.
      // Store the PRE-displacement position as the point's base geometry —
      // snapshotting the displaced position compounds noise on every re-target.
      BX[i] = x; BY[i] = y;

      let calm = this.frozen ? 0 : 1;
      if (this.calmIn) calm = Math.min(calm, 1 - ease(raw));
      else if (this.calmOut) calm = Math.min(1, ease(raw) * 1.6);
      const wob = calm * Math.max(this.running ? 0.55 : 1, 1 - settle);
      if (wob > 0.002) {
        // Spatially coherent flow field — neighbours drift together, so the
        // surface undulates as one mass instead of rippling per particle.
        const flow = this.running ? 0.9 + 1.5 * Math.sin(Math.PI * Math.min(1, raw)) : 2.4;
        const amp = flow * wob;
        const T = this.running ? 3.2 : 1;
        x += (Math.sin(x * 0.030 + now * T / 2100) + Math.sin(y * 0.023 - now * T / 2600)) * amp;
        y += (Math.cos(x * 0.026 - now * T / 2400) + Math.cos(y * 0.033 + now * T / 1900)) * amp;
      }

      // Droplets bud off the rim and get drawn back in.
      const dx0 = x - CENTER, dy0 = y - CENTER;
      const rr = Math.hypot(dx0, dy0);
      if (rr > 12) {
        if (this.running && calm > 0.01) {
          const inflight = Math.sin(Math.PI * Math.min(1, raw));
          if (inflight > 0.02) {
            const bud = Math.sin(now / 620 + sd * 6.283) * Math.sin(now / 1400 + sd * 12.57);
            const out = bud * Math.pow(Math.min(1, rr / 34), 1.8) * 4 * inflight * this.rScale * calm;
            x += (dx0 / rr) * out; y += (dy0 / rr) * out;
          }
        } else if (!this.running) {
          // Dormant: rectified, so droplets bud outward and are drawn back in.
          const bud = Math.sin(now / 1250 + sd * 6.283) * Math.sin(now / 2900 + sd * 12.57);
          const out = Math.max(0, bud) * Math.pow(Math.min(1, rr / 34), 2.2) * 15;
          x += (dx0 / rr) * out; y += (dy0 / rr) * out;
        }
      }

      PX[i] = x; PY[i] = y;
      if (x < nx0) nx0 = x; if (x > nx1) nx1 = x;
      if (y < ny0) ny0 = y; if (y > ny1) ny1 = y;
    }

    // Exact framing, measured from THIS frame so nothing swells or drifts.
    // Correct each axis SEPARATELY — a single scalar from the larger dimension
    // lets any aspect-distorting behaviour (fold, lathe, inhale) pass through.
    let kx = 1, ky = 1, ndx = 0, ndy = 0;
    if (this.bbFrom && this.bbTo && this.running) {
      const eB = ease(raw);
      const iW = this.bbFrom.w + (this.bbTo.w - this.bbFrom.w) * eB;
      const iH = this.bbFrom.h + (this.bbTo.h - this.bbFrom.h) * eB;
      const iCx = this.bbFrom.cx + (this.bbTo.cx - this.bbFrom.cx) * eB;
      const iCy = this.bbFrom.cy + (this.bbTo.cy - this.bbFrom.cy) * eB;
      const cw = (nx1 - nx0) || 1, ch = (ny1 - ny0) || 1;
      kx = Math.max(0.4, Math.min(2.2, iW / cw));
      ky = Math.max(0.4, Math.min(2.2, iH / ch));
      ndx = (nx0 + nx1) / 2 - iCx;
      ndy = (ny0 + ny1) / 2 - iCy;
    }

    for (let i = 0; i < this.n; i++) {
      const x = CENTER + (PX[i] - CENTER - ndx) * kx;
      const y = CENTER + (PY[i] - CENTER - ndy) * ky;
      this.cur[i].x = CENTER + (BX[i] - CENTER - ndx) * kx;
      this.cur[i].y = CENTER + (BY[i] - CENTER - ndy) * ky;
      const px = ox + bobX + (x - CENTER) / 120 * S * breathe;
      const py = oy + bobY + (y - CENTER) / 120 * S * breathe;
      ctx.drawImage(sp, (px - SD / 2) | 0, (py - SD / 2) | 0);
    }
    ctx.globalCompositeOperation = 'source-over';
  };
}
```

- [ ] **Step 3: Confirm the unit suite still passes**

Run: `npm test`
Expected: PASS. (`engine.js` and `sampling.js` are browser-only and are not imported by any unit test — this step confirms Tasks 2–5 didn't regress.)

- [ ] **Step 4: Commit**

```bash
git add src/scripts/spelling/sampling.js src/scripts/spelling/engine.js
git commit -m "feat(spelling): port the render loop, framing lock and looping sequencer"
```

---

### Task 7: Mount on the landing page

**Files:**
- Create: `src/components/Spelling.astro`
- Modify: `src/pages/index.astro`

**Interfaces:**
- Consumes: `SpellingEngine` from `engine.js`.
- Produces: a `<Spelling />` component rendering `<canvas id="spelling">` inside a sized wrapper, self-mounting on load.

- [ ] **Step 1: Create `src/components/Spelling.astro`**

```astro
---
// The Morphics Spelling engine: a white metaball mass that spells the tagline in
// the constructed alphabet, resolves the phrase, collapses to a dormant blob, and
// repeats forever. Purely decorative — pointer-events are off and it carries no
// text, so the Latin tagline below it remains the accessible content.
---

<div class="spelling" aria-hidden="true">
  <canvas id="spelling"></canvas>
</div>

<style>
  .spelling {
    display: grid;
    place-items: center;
    width: 100%;
    margin: 0 auto;
  }

  #spelling {
    display: block;
    width: 300px;
    height: 300px;
    pointer-events: none;
    background: #000;
  }

  @media (min-width: 640px) {
    #spelling { width: 380px; height: 380px; }
  }

  @media (min-width: 1024px) {
    #spelling { width: 430px; height: 430px; }
  }
</style>

<script>
  import { SpellingEngine } from '../scripts/spelling/engine.js';

  const canvas = document.getElementById('spelling');
  if (canvas) {
    const small = window.matchMedia('(max-width: 639px)').matches;
    const engine = new SpellingEngine(canvas, {
      letterPoints: small ? 600 : 900,
      maxPoints: small ? 3600 : 7200,
    });

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) {
      // Hold one settled frame: no rAF loop, no flow field, no droplet budding.
      engine.frozen = true;
      engine.size();
      engine.frame(performance.now());
    } else {
      // Only run while the canvas is actually on screen.
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) engine.start();
          else engine.stop();
        }
      }, { threshold: 0.01 });
      io.observe(canvas);

      window.addEventListener('pagehide', () => { io.disconnect(); engine.destroy(); });
    }

    window.addEventListener('resize', () => engine.size());
  }
</script>
```

- [ ] **Step 2: Wire it into `src/pages/index.astro`**

Add the import to the frontmatter:

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
import Spelling from '../components/Spelling.astro';
---
```

Then insert the component between the `</h1>` and the `<p>` tagline, replacing the `<h1>`'s `mb-6` with `mb-4` so the mass isn't crowded:

```astro
      <h1 class="mb-4">
        <img
          src="/images/logos/morphics-text-white.png"
          alt="MORPHICS"
          class="max-h-24 md:h-36 lg:h-44 w-auto mx-auto"
        />
      </h1>
      <Spelling />
      <p class="font-body text-lg md:text-xl text-on-surface-variant font-light tracking-wide max-w-lg mx-auto mb-12">
        The only constant is change.
      </p>
```

Leave the `<section>`, the `<a href="/music">` ENTER button, and every other class untouched. Note the hero's `min-h-[calc(100dvh-12rem)]`: with the canvas added the content may now exceed the viewport on short screens, which is acceptable — the section is `flex flex-col items-center justify-center`, so it grows.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: build succeeds. If `prebuild` fails because the Brain DB is unreachable, run `npx astro build` directly instead — the sync scripts are unrelated to this change.

- [ ] **Step 4: Look at it**

```bash
npm run dev
```

Open `http://localhost:4321/`. Confirm by eye, in this order:

1. A white mass is visible below the wordmark and is never static.
2. Within a few seconds it starts forming recognisable glyphs — compare against `public/glyphs/svg/T.svg` opened in a browser.
3. After the last glyph, five stacked word-lines resolve and hold for ~1.5s.
4. It collapses back to a formless mass and, after ~2s, begins spelling again.
5. Strokes are hard-edged, not soft or fat. If they look fat, the sprite feather or blur constant was altered.

- [ ] **Step 5: Commit**

```bash
git add src/components/Spelling.astro src/pages/index.astro
git commit -m "feat(landing): mount the Spelling animation below the wordmark"
```

---

### Task 8: Headless verification

The README's own acceptance test: rasterise a settled glyph, threshold it, and compare against the source SVG rendered at the same size. Intersection-over-union should reach about **0.90**. Per the README this "caught several bugs during development that looked fine".

**Files:**
- Create: `scripts/verify-spelling.mjs`
- Create: `docs/superpowers/plans/2026-08-12-landing-spelling-results.md`

**Interfaces:**
- Consumes: the built site in `dist/`, `SpellingEngine`.
- Produces: a script that exits non-zero if IoU < 0.85 for any tagline glyph, and prints the per-glyph figures.

- [ ] **Step 1: Write the verification script**

Create `scripts/verify-spelling.mjs`. It serves `dist/`, drives `chrome-headless-shell` over CDP (Node 24 has a global `WebSocket`, so no ws dependency), and for each unique tagline glyph: constructs an engine on an offscreen canvas, morphs directly to that glyph with `frozen = true`, renders one frame, thresholds the result, renders the source SVG to a second canvas at the same size, thresholds that, and computes IoU.

```js
// Verify the Spelling engine against its source glyphs, per the design handoff:
// rasterise a settled glyph, threshold it, compare to the SVG at the same size.
// IoU should reach ~0.90. Usage: node scripts/verify-spelling.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = 4399;
const ROOT = new URL('../dist/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml',
                '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  let p = normalize(decodeURI(req.url.split('?')[0]));
  if (p.endsWith('/')) p += 'index.html';
  try {
    const buf = await readFile(join(ROOT, p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('nope');
  }
});
await new Promise(r => server.listen(PORT, r));

const chrome = spawn('chrome-headless-shell', [
  '--headless', '--remote-debugging-port=9333', '--disable-gpu',
  '--no-sandbox', '--window-size=900,900', 'about:blank'
], { stdio: 'ignore' });

const wait = ms => new Promise(r => setTimeout(r, ms));
await wait(1200);

const targets = await fetch('http://127.0.0.1:9333/json/list').then(r => r.json());
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });

let id = 0;
const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params) => new Promise(r => {
  const i = ++id;
  pending.set(i, r);
  ws.send(JSON.stringify({ id: i, method, params }));
});

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await wait(2500);

const results = await evaluate(`(async () => {
  const { SpellingEngine } = await import('/scripts/spelling/engine.js');
  const { flatten } = await import('/scripts/spelling/glyph-parse.js');
  const { samplePoints } = await import('/scripts/spelling/sampling.js');
  const SIZE = 430;
  const out = {};

  const mask = (ctx) => {
    const d = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const m = new Uint8Array(SIZE * SIZE);
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4] > 127 ? 1 : 0;
    return m;
  };

  for (const ch of [...new Set('THEONLYCONSTANTISCHANGE')]) {
    // 1. the engine's rendering, settled
    const c = document.createElement('canvas');
    c.style.cssText = 'width:' + SIZE + 'px;height:' + SIZE + 'px;position:fixed;left:-9999px';
    document.body.appendChild(c);
    const eng = new SpellingEngine(c);
    eng.size();
    const pts = await eng.glyph(ch, 900);
    eng.cur = pts.map(p => ({ x: p.x, y: p.y }));
    eng.from = eng.cur.map(p => ({ x: p.x, y: p.y }));
    eng.to = eng.cur.map(p => ({ x: p.x, y: p.y }));
    eng.frozen = true;
    eng.t0 = performance.now() - 10000;
    eng.dur = 1;
    eng.frame(performance.now());

    // the CSS filter is what thresholds the mass, so read back through it
    const shot = document.createElement('canvas');
    shot.width = shot.height = SIZE;
    const sctx = shot.getContext('2d');
    sctx.filter = c.style.filter;
    sctx.drawImage(c, 0, 0, SIZE, SIZE);
    const A = mask(sctx);

    // 2. the source SVG at the same size
    const txt = await fetch('/glyphs/svg/' + ch + '.svg').then(r => r.text());
    const ref = document.createElement('canvas');
    ref.width = ref.height = SIZE;
    const rctx = ref.getContext('2d');
    rctx.fillStyle = '#000';
    rctx.fillRect(0, 0, SIZE, SIZE);
    const img = new Image();
    const white = txt.replace(/#000/g, '#fff').replace(/black/g, '#fff');
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(white)));
    await img.decode();
    // the engine draws the artboard at min(W,H) * 0.66, centred
    const S = SIZE * 0.66;
    rctx.drawImage(img, (SIZE - S) / 2, (SIZE - S) / 2, S, S);
    const B = mask(rctx);

    let inter = 0, uni = 0;
    for (let i = 0; i < A.length; i++) {
      if (A[i] | B[i]) uni++;
      if (A[i] & B[i]) inter++;
    }
    out[ch] = uni ? inter / uni : 0;
    c.remove();
  }
  return out;
})()`);

console.log('IoU vs source SVG (target ~0.90):');
let worst = 1;
for (const [ch, iou] of Object.entries(results).sort((a, b) => a[1] - b[1])) {
  console.log('  ' + ch + '  ' + iou.toFixed(3));
  worst = Math.min(worst, iou);
}

ws.close();
chrome.kill();
server.close();

if (worst < 0.85) {
  console.error('\nFAIL: worst IoU ' + worst.toFixed(3) + ' is below 0.85');
  process.exit(1);
}
console.log('\nPASS: worst IoU ' + worst.toFixed(3));
```

- [ ] **Step 2: Check `chrome-headless-shell` is available**

```bash
which chrome-headless-shell || npx @puppeteer/browsers install chrome-headless-shell@stable
```

If it installs to a local path, use that absolute path in the `spawn` call rather than the bare name.

- [ ] **Step 3: Build and run the verification**

```bash
npm run build && node scripts/verify-spelling.mjs
```

Expected: a per-glyph IoU table and `PASS`.

If IoU is low across the board, the likely causes in order: (a) the reference render's `S = SIZE * 0.66` scale doesn't match how the SVG's own artboard maps — print both masks' bounding boxes and compare; (b) the sprite radius or blur constant was altered from the calibrated values; (c) `dpr` is not 1.

If exactly one or two glyphs are low while the rest pass, that is a real geometry bug in `flatten` for those glyphs — inspect their SVG for a transform shape the three regexes don't match.

- [ ] **Step 4: Verify the loop and the guards by hand**

With `npm run dev` running, in the browser console on `/`:

```js
// 1. the loop repeats: watch two full cycles, ~60s
// 2. off-screen pause
window.scrollTo(0, 5000);   // canvas leaves the viewport
// confirm in Performance that scripting drops to ~0
window.scrollTo(0, 0);      // it resumes

// 3. hidden-tab skip: switch tabs for 10s, return — no burst of catch-up frames
```

Then in devtools Rendering → "Emulate CSS media feature prefers-reduced-motion: reduce", reload, and confirm: one static settled frame, and `performance.getEntriesByType('measure')` shows no ongoing rAF work.

- [ ] **Step 5: Record the results**

Create `docs/superpowers/plans/2026-08-12-landing-spelling-results.md` with the actual IoU table pasted from Step 3, plus a line each for the four manual checks in Step 4 stating pass or fail with what was observed. Do not write "verified" without the numbers.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-spelling.mjs docs/superpowers/plans/2026-08-12-landing-spelling-results.md
git commit -m "test(spelling): headless IoU verification against source glyphs"
```

---

## Verification summary

| requirement (from the spec) | covered by |
|---|---|
| Engine ported, calibrated constants intact | Tasks 2–6; measured in Task 8 |
| One word per line, auto-fit scale, canvas-derived view scale | Task 4 tests |
| 25 behaviours, peak-mid-transition, land on target | Task 5 tests |
| Prototype UI dropped | Tasks 6–7 (no UI ported) |
| Loops forever with a 2s dormant rest | Task 6 `cycle()`; Task 8 Step 4 |
| Glyphs fetched lazily from `/glyphs/svg/`, cached | Task 6 `parts()`; Task 1 asset test |
| Mobile: 300px canvas, 600/3600 point budgets | Task 7 component |
| `dpr = 1`, 48fps cap, `document.hidden` skip | Task 6 `size()` / `frame()` |
| IntersectionObserver pause | Task 7; Task 8 Step 4 |
| `prefers-reduced-motion` → one static frame | Task 7; Task 8 Step 4 |
| Wordmark / tagline / ENTER unchanged | Task 7 Step 2 |
| IoU ≈ 0.90 vs source SVGs | Task 8 |
