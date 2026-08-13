// The v2 scramble grid: 27 independently morphing glyph cells sharing one
// canvas, one sprite, and one filter pass. See
// docs/superpowers/specs/2026-08-12-landing-scramble-grid-design.md.
//
// Reuses, unmodified, the calibrated pieces from the v1 engine: CHARMAP/HALF/
// CENTER, the SVG flattener + sampler, 24-sector pairing, the 25 behaviours,
// and the render pipeline (sprite, additive compositing, alpha-threshold
// filter, dpr=1, 48fps cap, hidden-tab skip) via render-shared.js. What's new
// is the sequencer: N independent cell clocks instead of one travelling mass,
// and per-cell containment instead of a single global framing lock.
import { CHARMAP, CENTER, HALF, PHRASE } from './charmap.js';
import { flatten } from './glyph-parse.js';
import { samplePoints } from './sampling.js';
import { ease } from './shapes.js';
import { assign, box } from './pairing.js';
import { displace, leadFor, pickMode } from './behaviours.js';
import { makeSprite, makeFixedSprite, makeExactSprite, resolveGooBlur, createFrameLoop } from './render-shared.js';
import { planGrid, planFreeGrid, staggerRanks, nextLetter } from './grid-layout.js';

const clone = (p) => ({ x: p.x, y: p.y });

// Resolve stagger + duration: total sweep lands at ~700ms per spec (a "few
// tens of ms" per rank, ordered left-to-right, resolving in ~700ms overall).
// Fraction of a cell the glyph's 120-unit artboard occupies. v1 used 0.66 for a
// single mass on a large canvas; in the grid each cell is far smaller, so the
// glyph is pushed closer to the cell edge to stay legible. Raising this makes
// the glyph bigger WITHOUT changing the stroke-to-glyph ratio (the sprite radius
// is derived from the same number), so counters stay open instead of the blur
// closing them into a blob.
const GLYPH_FILL = 0.95;

// Stroke weight relative to the glyph's own 13-unit house stroke. 0.90 is the
// design reference's calibrated value and reproduces the alphabet's true
// proportions; a lighter pen makes letters that no longer match the real
// glyphs. If letters read as too heavy, the fix is more device pixels per
// glyph (renderScale / cellTarget), not a thinner pen.
const STROKE_WEIGHT = 0.90;

// Blur relative to the sprite radius. The design reference used 0.71 for one
// large mass, where heavy fusion is the point. At grid scale that much blur
// rounds every corner and fills the counters, so the letterforms stop matching
// the real alphabet. Lower = crisper, at the cost of needing denser points.
const BLUR_RATIO = 0.34;

// Behaviours that keep the mass coherent while it travels. The full 25 include
// split / seam / boil / tendril / braid, which deliberately tear the form apart
// mid-morph — striking on one large glyph, but across a field of small letters
// they read as a swarm of loose particles rather than letters changing.
// Every cell must read as a LETTER at essentially all times. The morph
// inherently passes through a non-letter state, so two things keep it legible:
// this set is restricted to behaviours that preserve the form as a whole
// (uniform scale / squeeze) rather than staggering, rotating or tearing it —
// a staggered behaviour leaves half the glyph behind and reads as debris —
// and the morph itself is short, so the in-between is a brief snap.
const GRID_MODES = ['direct', 'implode', 'quench', 'inhale', 'lathe'];
const pickGridMode = (prev) => {
  let m = GRID_MODES[(Math.random() * GRID_MODES.length) | 0];
  while (m === prev && GRID_MODES.length > 1) m = GRID_MODES[(Math.random() * GRID_MODES.length) | 0];
  return m;
};

const RESOLVE_DUR = 520;
const RESOLVE_STAGGER_TOTAL = 180;

export class ScrambleGridEngine {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.n = opts.cellPoints ?? 240;
    // Free (word-search) mode vs the fixed phrase grid.
    this.free = opts.free ?? false;
    this.cellTarget = opts.cellTarget ?? 120;
    this.extraRows = opts.extraRows ?? 0;
    this.pointBudget = opts.pointBudget ?? 9000;
    this.minCellPoints = opts.minCellPoints ?? 45;
    this.morphMs = opts.morphMs ?? 620;
    this.holdMs = opts.holdMs ?? 380;
    this.glyphBase = opts.glyphBase ?? '/glyphs/svg/';

    this.cache = {};       // char id -> flattened SVG parts
    this.dpr = 1;
    // The SVG goo filter is the dominant per-frame cost and scales with backing
    // -store AREA. A full-viewport canvas is ~20x the area of v1's 430px square,
    // so the grid rasterises below layout size and lets CSS scale it up — the
    // form is heavily blurred, so the lost resolution is not visible.
    this.renderScale = opts.renderScale ?? 0.55;
    // 0 = run at vsync. See createFrameLoop: a 20ms cap judders on a 60Hz display.
    this.loop = createFrameLoop((now) => this.renderFrame(now), 0);
    this.resolved = false;
    this.resolvedSince = performance.now();
    this.cells = [];
    this.staggerMs = [];
    this.frozen = false;

    this.layout();
  }

  // ---- layout -------------------------------------------------------------

  // Backing-store size (matches v1: dpr stays 1 so the CSS filter, which
  // applies at display scale, isn't scaled up with it) plus the pure grid
  // arithmetic from grid-layout.js.
  size() {
    const c = this.canvas;
    if (!c || !c.clientWidth) return;
    const w = Math.floor(c.clientWidth * this.dpr * this.renderScale);
    const h = Math.floor(c.clientHeight * this.dpr * this.renderScale);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this.layout();
  }

  layout() {
    const c = this.canvas;
    const W = (c && c.width) || 900, H = (c && c.height) || 260;
    if (this.W === W && this.H === H && this.cells.length) return;
    this.needsPhraseAssign = true;
    this.W = W; this.H = H;

    // Free mode fills the canvas with a lattice of independent random letters
    // (the word-search field). Phrase mode keeps the fixed three-row grid.
    // Point budget is spread across however many cells the canvas fits: total
    // points, not cell count, is what drives frame cost, and a measured cliff
    // sits near 16000 points in this Chrome build.
    const plan = this.free
      ? planFreeGrid(W, H, { target: this.cellTarget * this.renderScale, extraRows: this.extraRows })
      : planGrid(W, H);
    if (this.free) {
      this.cols = plan.cols; this.rows = plan.rows;
      this.n = Math.max(this.minCellPoints, Math.min(this.n, Math.floor(this.pointBudget / plan.cells.length)));
    }
    this.cellW = plan.cellW;
    this.cellH = plan.cellH;
    const ranks = staggerRanks(plan.cells);
    const maxRank = Math.max(1, ...ranks);
    this.staggerMs = ranks.map((r) => (r / maxRank) * RESOLVE_STAGGER_TOTAL);

    const now = performance.now();
    this.cells = plan.cells.map((slot, i) => this.makeCell(slot, i, now));
    if (this.needsPhraseAssign) { this.assignPhrase(); this.needsPhraseAssign = false; }
  }

  // One bitmap per settled letter, shared by every cell holding that letter.
  // Rendered from the same sprites at the same size, so a cached blit is
  // pixel-identical to drawing the discs individually. Invalidated whenever
  // the cell size or sprite changes (resize).
  settledBitmap(cell, S, sp, SD) {
    const key = cell.displayChar;
    if (!key || !cell.hasGlyph || !cell.to || !cell.to.length) return null;
    if (this.bmpKey !== S + ':' + SD) { this.bmpCache = new Map(); this.bmpKey = S + ':' + SD; }
    const hit = this.bmpCache.get(key);
    if (hit) return hit;

    const size = Math.ceil(Math.max(this.cellW, this.cellH) + SD * 2);
    const off = document.createElement('canvas');
    off.width = off.height = size;
    const g = off.getContext('2d');
    const c0 = size / 2;
    for (let i = 0; i < cell.to.length; i++) {
      const b = cell.to[i];
      g.drawImage(sp, c0 + (b.x - CENTER) / 120 * S - SD / 2, c0 + (b.y - CENTER) / 120 * S - SD / 2);
    }
    this.bmpCache.set(key, off);
    return off;
  }

  // The ENTER button's rect in CSS px relative to the canvas; the phrase is
  // placed in the lattice rows directly beneath it.
  setPhraseAnchor(rect) {
    this.anchor = rect;
    this.assignPhrase();
  }

  // Gap-free AND word-safe: words are packed greedily into rows, then joined
  // with NO separator. A space would leave a hole in the lattice; splitting a
  // word across rows makes it unreadable.
  assignPhrase() {
    for (const cell of this.cells) cell.phraseChar = null;
    if (!this.anchor || !this.cols || !this.cellW) return;

    const sc = this.renderScale;
    const anchorCx = (this.anchor.cx || 0) * sc;
    const anchorBottom = (this.anchor.bottom || 0) * sc;

    const maxPerRow = Math.max(1, this.cols - 2);
    const words = PHRASE.toUpperCase().split(/\s+/).filter(Boolean);
    const packed = [];
    let row = '';
    for (const w of words) {
      if (row && row.length + w.length > maxPerRow) { packed.push(row); row = w; }
      else row += w;
    }
    if (row) packed.push(row);

    let startRow = 0;
    while (startRow < this.rows && (startRow + 0.5) * this.cellH < anchorBottom) startRow++;
    startRow += 1;

    packed.forEach((text, li) => {
      const r = startRow + li;
      if (r >= this.rows) return;
      const startCol = Math.round(anchorCx / this.cellW - text.length / 2);
      for (let k = 0; k < text.length; k++) {
        const c = startCol + k;
        if (c < 0 || c >= this.cols) continue;
        const cell = this.cells[r * this.cols + c];
        if (cell) cell.phraseChar = text[k];
      }
    });
  }

  makeCell(slot, i, now) {
    const isSpace = slot.ch === ' ';
    const startLetter = nextLetter(null);
    const pts = this.spherePlaceholder();
    return {
      cx: slot.cx, cy: slot.cy, w: slot.w, h: slot.h,
      trueChar: slot.ch,
      isSpace,
      displayChar: startLetter,
      phraseChar: null,
      // False until the first REAL glyph lands: a placeholder must never be
      // cached under a letter key (that turned the whole field into dots).
      hasGlyph: false,
      mode: 'direct',
      cur: pts.map(clone),
      from: pts.map(clone),
      to: pts.map(clone),
      seed: pts.map(() => Math.random()),
      bbFrom: box(pts),
      bbTo: box(pts),
      // Randomised phase offset at mount, spread forward across one full
      // scramble cycle, so cells never tick in unison — even on frame 1.
      t0: now,
      dur: 1,
      nextAt: now + Math.random() * 700,
      appliedResolved: false,
      gen: 0, // bumped on every scheduled async morph target; guards against a
               // slower in-flight fetch stomping a newer target after a fast
               // hover-on-off-on
      alpha: isSpace ? 1 : 1,
      alphaFrom: 1, alphaTo: 1, alphaT0: now, alphaDur: 1,
    };
  }

  spherePlaceholder() {
    // A tight seed cluster — real geometry lands on the first scramble morph,
    // a frame or two after mount, so this never has to look right on its own.
    const pts = [];
    for (let i = 0; i < this.n; i++) pts.push({ x: CENTER, y: CENTER });
    return pts;
  }

  // ---- glyph geometry (identical caching strategy to v1) -------------------

  async parts(ch) {
    const id = CHARMAP[ch.toUpperCase()];
    if (!id) return null;
    if (this.cache[id]) return this.cache[id];
    try {
      const txt = await fetch(this.glyphBase + id + '.svg').then((r) => r.text());
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

  // Fire-and-forget: cache every A-Z glyph up front so the first scramble
  // morphs don't stall on network. Safe to call multiple times.
  async warm() {
    await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => this.parts(c)));
  }

  // ---- resolve / release ---------------------------------------------------

  enterResolve() {
    if (this.resolved) return;
    this.resolved = true;
    this.resolvedSince = performance.now();
  }

  leaveResolve() {
    if (!this.resolved) return;
    this.resolved = false;
    this.resolvedSince = performance.now();
  }

  // ---- per-cell morph scheduling -------------------------------------------

  cellMorphTo(cell, pts, mode, dur, now) {
    cell.from = cell.cur.map(clone);
    cell.to = assign(cell.from, pts);
    cell.bbFrom = cell.bbTo || box(cell.from);
    cell.bbTo = box(cell.to);
    cell.mode = mode || pickGridMode(cell.mode);
    cell.t0 = now;
    cell.dur = dur;
  }

  cellAlphaTo(cell, target, dur, now) {
    if (cell.alphaTo === target) return;
    cell.alphaFrom = cell.alpha;
    cell.alphaTo = target;
    cell.alphaT0 = now;
    cell.alphaDur = dur;
  }

  // `gen` guards every async schedule call: a fast hover-on-off-on can issue
  // a scramble fetch and a resolve fetch for the same cell in close
  // succession, and whichever resolves LAST would otherwise stomp the
  // other's already-current target. Capturing the cell's generation before
  // the await and checking it after makes only the most-recently-issued
  // request able to apply — no stranded or double-scheduled cell.
  async scheduleScramble(cell, now) {
    const myGen = ++cell.gen;
    const letter = nextLetter(cell.displayChar);
    const pts = await this.glyph(letter);
    if (!pts || cell.gen !== myGen) return;
    cell.displayChar = letter;
    cell.hasGlyph = true;
    this.cellMorphTo(cell, pts, pickGridMode(cell.mode), this.morphMs, performance.now());
  }

  async scheduleResolveLetter(cell, now) {
    const myGen = ++cell.gen;
    const target = cell.phraseChar || cell.trueChar;
    const pts = await this.glyph(target);
    if (!pts || cell.gen !== myGen) return;
    cell.displayChar = target;
    cell.hasGlyph = true;
    this.cellMorphTo(cell, pts, pickGridMode(cell.mode), RESOLVE_DUR, performance.now());
  }

  // ---- the per-frame tick ---------------------------------------------------

  tickCell(cell, i, now) {
    // Only cells carrying a phrase character react to the hover; every other
    // cell free-runs its own scramble the whole time. A resolved phrase cell
    // then holds its letter for as long as the hover lasts.
    const wantResolved = this.resolved && !!cell.phraseChar;
    const triggerAt = this.resolvedSince + (this.staggerMs[i] || 0);
    if (now >= triggerAt && cell.appliedResolved !== wantResolved) {
      cell.appliedResolved = wantResolved;
      if (wantResolved) {
        if (false) {
          // Fade to nothing; leave point geometry where it is (no glyph to
          // morph to) so the fade reads as a dissolve, not a snap.
          this.cellAlphaTo(cell, 0, RESOLVE_DUR, now);
        } else {
          this.cellAlphaTo(cell, 1, RESOLVE_DUR, now);
          this.scheduleResolveLetter(cell, now);
        }
      } else {
        this.cellAlphaTo(cell, 1, RESOLVE_DUR, now);
        this.scheduleScramble(cell, now);
        cell.nextAt = now + RESOLVE_DUR + this.holdMs;
      }
    }

    // Independent scramble cadence: only while NOT resolved (or not yet
    // reacted to a resolve request) does a cell free-run its own hold/morph
    // cycle — this is what keeps cells from ticking in unison.
    if (!cell.appliedResolved && now >= cell.nextAt) {
      cell.nextAt = now + this.morphMs + this.holdMs * (0.45 + Math.random() * 1.35);
      this.scheduleScramble(cell, now);
    }
  }

  // ---- render ---------------------------------------------------------------

  gooBlurEl() {
    if (this._gooBlurEl) return this._gooBlurEl;
    const blur = resolveGooBlur(this.canvas, 'spelling-grid-goo');
    if (blur) this._gooBlurEl = blur;
    return blur;
  }

  renderFrame(now) {
    const c = this.canvas;
    if (!c || !c.isConnected || !c.clientWidth) return;
    if (!c.width || c.width !== Math.floor(c.clientWidth * this.dpr * this.renderScale)) this.size();
    if (!this.cells.length) return;

    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);

    // One radius for the whole canvas — cells share a uniform size, so one
    // sprite and one filter stdDeviation serve every cell (single filter pass).
    const S0 = Math.min(this.cellW, this.cellH) * GLYPH_FILL * (HALF / 120) * STROKE_WEIGHT;
    this.Rpx = S0;
    const D = S0 * 2.24;
    // Fixed-resolution bitmap, drawn scaled to the true diameter D. Decoupling
    // bitmap resolution from stroke size is what makes thickness scale with
    // glyph size instead of pinning to makeSprite's 4px floor.
    if (!this.sprite || Math.abs(this.spriteDrawn - D) > 0.25) {
      const sp = makeExactSprite(D);
      this.sprite = sp.sprite; this.spriteD = sp.spriteD; this.spriteDrawn = D;
    }

    if (!this.fltNow) { c.style.filter = 'url(#spelling-grid-goo)'; this.fltNow = true; }
    const stdDev = (S0 * BLUR_RATIO).toFixed(2);
    if (this.stdDevNow !== stdDev) {
      const blurEl = this.gooBlurEl();
      if (blurEl) blurEl.setAttribute('stdDeviation', stdDev);
      this.stdDevNow = stdDev;
    }

    const S = Math.min(this.cellW, this.cellH) * GLYPH_FILL;
    const sp = this.sprite, SD = this.spriteD;
    ctx.globalCompositeOperation = 'source-over';

    for (let ci = 0; ci < this.cells.length; ci++) {
      const cell = this.cells[ci];
      if (!this.frozen) this.tickCell(cell, ci, now);

      const raw = cell.dur <= 1 ? 1 : Math.min(1, (now - cell.t0) / cell.dur);
      const eB = ease(raw);

      const n = cell.cur.length;
      if (!cell.PX || cell.PX.length < n) {
        cell.PX = new Float32Array(n); cell.PY = new Float32Array(n);
        cell.BX = new Float32Array(n); cell.BY = new Float32Array(n);
      }
      const PX = cell.PX, PY = cell.PY, BX = cell.BX, BY = cell.BY;
      let nx0 = 1e9, ny0 = 1e9, nx1 = -1e9, ny1 = -1e9;

      if (raw >= 1) {
        // Settled: the morph has landed and this cell is a STATIC glyph until
        // its next morph. Blit one cached bitmap instead of re-drawing every
        // disc — the per-particle draw loop is the frame's dominant cost, and
        // most cells are holding at any instant.
        const bmp = this.settledBitmap(cell, S, sp, SD);
        if (bmp) {
          if (cell.alphaDur > 1) {
            const at = Math.min(1, (now - cell.alphaT0) / cell.alphaDur);
            cell.alpha = cell.alphaFrom + (cell.alphaTo - cell.alphaFrom) * ease(at);
          } else {
            cell.alpha = cell.alphaTo;
          }
          if (cell.alpha <= 0.004) continue;
          ctx.globalAlpha = cell.alpha;
          ctx.drawImage(bmp, cell.cx - bmp.width / 2, cell.cy - bmp.height / 2);
          continue;
        }
        for (let i = 0; i < n; i++) {
          const b = cell.to[i];
          BX[i] = b.x; BY[i] = b.y;
          PX[i] = b.x; PY[i] = b.y;
        }
      } else {
        for (let i = 0; i < n; i++) {
          const a = cell.from[i], b = cell.to[i], sd = cell.seed[i];
          const lead = leadFor(cell.mode, b, i, n, sd);
          const tt = Math.max(0, Math.min(1, (raw - lead) / (1 - lead || 1)));
          const d = displace(cell.mode, a, b, tt, i, sd, now);
          BX[i] = d.x; BY[i] = d.y;
          PX[i] = d.x; PY[i] = d.y;
          if (d.x < nx0) nx0 = d.x; if (d.x > nx1) nx1 = d.x;
          if (d.y < ny0) ny0 = d.y; if (d.y > ny1) ny1 = d.y;
        }
      }

      // Per-cell containment: same per-axis correction as v1's global framing
      // lock, scoped to this cell's own before/after box, measured within
      // this same frame from the pre-displacement (base) positions.
      let kx = 1, ky = 1, ndx = 0, ndy = 0;
      if (cell.bbFrom && cell.bbTo && raw < 1) {
        const iW = cell.bbFrom.w + (cell.bbTo.w - cell.bbFrom.w) * eB;
        const iH = cell.bbFrom.h + (cell.bbTo.h - cell.bbFrom.h) * eB;
        const iCx = cell.bbFrom.cx + (cell.bbTo.cx - cell.bbFrom.cx) * eB;
        const iCy = cell.bbFrom.cy + (cell.bbTo.cy - cell.bbFrom.cy) * eB;
        const cw = (nx1 - nx0) || 1, ch_ = (ny1 - ny0) || 1;
        kx = Math.max(0.4, Math.min(2.2, iW / cw));
        ky = Math.max(0.4, Math.min(2.2, iH / ch_));
        ndx = (nx0 + nx1) / 2 - iCx;
        ndy = (ny0 + ny1) / 2 - iCy;
      }

      // Fade (space cells resolving/releasing).
      if (cell.alphaDur > 1) {
        const at = Math.min(1, (now - cell.alphaT0) / cell.alphaDur);
        cell.alpha = cell.alphaFrom + (cell.alphaTo - cell.alphaFrom) * ease(at);
      } else {
        cell.alpha = cell.alphaTo;
      }
      if (cell.alpha <= 0.004) continue; // nothing to draw

      ctx.globalAlpha = cell.alpha;
      for (let i = 0; i < n; i++) {
        const x = CENTER + (PX[i] - CENTER - ndx) * kx;
        const y = CENTER + (PY[i] - CENTER - ndy) * ky;
        cell.cur[i].x = CENTER + (BX[i] - CENTER - ndx) * kx;
        cell.cur[i].y = CENTER + (BY[i] - CENTER - ndy) * ky;
        const px = cell.cx + (x - CENTER) / 120 * S;
        const py = cell.cy + (y - CENTER) / 120 * S;
        // Subpixel position: at ~4px discs, snapping to whole pixels is a
        // large relative error and reads as lumpy stroke edges.
        ctx.drawImage(sp, px - SD / 2, py - SD / 2);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---- lifecycle -------------------------------------------------------------

  start() {
    this.size();
    this.loop.start();
    // Fire-and-forget: prefetch every A-Z glyph so the first scramble morphs
    // don't stall on the network one letter at a time.
    this.warm().catch((e) => console.error('ScrambleGridEngine: warm failed', e));
  }

  stop() {
    this.loop.stop();
  }

  destroy() {
    this.stop();
    this.cache = {};
  }

  // For prefers-reduced-motion: settle every cell on its true letter (space
  // cells invisible) with no scheduling, then render exactly one frame — no
  // rAF loop is ever armed.
  async renderResolvedOnce() {
    this.size();
    await this.warm();
    const now = performance.now();
    for (const cell of this.cells) {
      cell.appliedResolved = true;
      if (cell.isSpace) {
        cell.alpha = 0; cell.alphaFrom = 0; cell.alphaTo = 0; cell.alphaDur = 1;
        continue;
      }
      const pts = await this.glyph(cell.trueChar);
      if (!pts) continue;
      cell.cur = pts.map(clone);
      cell.from = cell.cur.map(clone);
      cell.to = cell.cur.map(clone);
      cell.mode = 'direct';
      cell.t0 = now - 10;
      cell.dur = 1;
      cell.alpha = 1; cell.alphaFrom = 1; cell.alphaTo = 1; cell.alphaDur = 1;
    }
    this.frozen = true;
    this.resolved = true;
    this.renderFrame(performance.now());
  }
}
