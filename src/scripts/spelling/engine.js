import { CHARMAP, CENTER, HALF, PHRASE } from './charmap.js';
import { flatten } from './glyph-parse.js';
import { samplePoints } from './sampling.js';
import { spherePoints, blobShape, ease } from './shapes.js';
import { assign, box } from './pairing.js';
import { planPhrase, viewScaleFor } from './layout.js';
import { IDLE_MODE, displace, leadFor, pickMode } from './behaviours.js';
import { makeSprite, resolveGooBlur, createFrameLoop } from './render-shared.js';

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
    this.loop = createFrameLoop((now) => this.renderFrame(now));
    this.timer = null;
    // Bumped on every start() so a loop resumed after a stop()/start() pair that
    // straddled an in-flight await (e.g. a glyph fetch) can tell it's stale and
    // bail instead of running concurrently with the new loop.
    this.generation = 0;
  }

  // ---- lifecycle ---------------------------------------------------------

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation++;
    const myGeneration = this.generation;
    this.size();
    this.loop.start();
    // Not awaited: this kicks off the fire-and-forget sequencer loop. Catch so a
    // transient failure inside it (e.g. a rejected fetch) can't surface as an
    // unhandled promise rejection.
    this.cycle(myGeneration).catch(e => {
      console.error('SpellingEngine: cycle failed', e);
    });
  }

  stop() {
    this.stopped = true;
    this.running = false;
    clearTimeout(this.timer);
    this.loop.stop();
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

  // True when a NEWER start() has run since `gen` was captured — a different
  // loop now owns this.running/this.timer/this.mode, so a stale resumption must
  // return without touching any of it. this.stopped alone (gen still current,
  // no restart yet) is different: nothing else owns the state, so it's safe to
  // clean up. Conflating the two was the bug — a stale loop resetting
  // this.running to false out from under a newer, still-active loop.
  stale(gen) {
    return gen !== this.generation;
  }

  // The reference's run() executes once. This repeats it forever.
  async cycle(gen) {
    while (!this.stopped && !this.stale(gen)) {
      await this.spellOnce(gen);
      if (this.stale(gen)) return;
      if (this.stopped) return;
      await this.wait(this.restMs);
      if (this.stale(gen)) return;
    }
  }

  async spellOnce(gen) {
    // Restores the source run()'s top-of-loop guard (line 428): never let a
    // second sequencer run concurrently against the same particle state.
    if (this.running) return;
    this.running = true;
    const chars = this.phrase.toUpperCase().split('');
    let last = null;

    for (const ch of chars) {
      if (this.stale(gen)) return;
      if (this.stopped) { this.running = false; return; }
      if (ch === ' ') {
        this.resize(this.N_LETTER);
        this.morphTo(spherePoints(this.n), 'implode');
        await this.wait(this.morphMs + 120);
        if (this.stale(gen)) return;
        if (this.stopped) { this.running = false; return; }
        continue;
      }
      // Required by the looping change (source's run() only ever spelled once,
      // so it never needed to re-grow the field): idleTick/the dormant tail
      // between cycles resizes down to N_IDLE, so without this every letter
      // after the first cycle would sample at N_IDLE (420) points instead of
      // N_LETTER (900). Do not remove as "redundant".
      this.resize(this.N_LETTER);
      const pts = await this.glyph(ch);
      if (this.stale(gen)) return;
      if (this.stopped) { this.running = false; return; }
      if (!pts) continue;
      last = pickMode(last);
      this.morphTo(pts, last);
      await this.wait(this.morphMs + this.holdMs);
      if (this.stale(gen)) return;
      if (this.stopped) { this.running = false; return; }
    }

    // The whole phrase resolves out of the last letter, seamlessly.
    let exiting = false;
    const mapped = chars.filter(c => CHARMAP[c]).length;
    if (mapped > 1) {
      const budget = Math.min(this.N_MAX, Math.max(this.N_LETTER, 700 * mapped));
      const w = await this.phrasePoints(this.phrase, budget);
      if (this.stale(gen)) return;
      if (this.stopped) { this.running = false; return; }
      if (w) {
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
        if (this.stale(gen)) return;
        if (this.stopped) { this.running = false; return; }
        this.calmIn = false;
        this.t0 = performance.now() - this.dur - 1;   // land the morph exactly
        this.frozen = true;
        await this.wait(this.holdMs * 4);
        // Stale: a newer generation already owns (and has reset) this.frozen
        // via its own morphTo() — touch nothing further.
        if (this.stale(gen)) return;
        if (this.stopped) { this.running = false; this.frozen = false; return; }
        this.frozen = false;
        exiting = true;
      }
    }

    // Return to dormant. This return is itself a morph, but running is already
    // false by the time it plays, so the framing lock (gated on this.running in
    // frame()) is OFF for it — matching the source exactly. That's intentional:
    // only the spelling morphs are framing-locked, not the dormant settle.
    this.running = false;
    if (this.stale(gen)) return;
    if (this.stopped) return;
    const tail = Math.round(this.morphMs * (exiting ? 1.9 : 1.6));
    this.resize(this.N_IDLE);
    this.morphTo(blobShape(this.N_IDLE), 'direct', tail, 1, 1);
    this.calmOut = exiting;
    this.nextIdle = performance.now() + tail;
    await this.wait(tail);
    if (this.stale(gen)) return;
  }

  // ---- render ------------------------------------------------------------

  // One pre-rendered blob, blitted per particle — a hard core with a short tail,
  // so blur+contrast thresholds right at the true stroke edge. A long gradient
  // tail sums to full white far past the core under additive blending, so the
  // threshold lands outside the intended edge and every stroke renders fat.
  makeSprite(D) {
    const { sprite, spriteD } = makeSprite(D);
    this.sprite = sprite;
    this.spriteD = spriteD;
  }

  // Resolve the goo filter's feGaussianBlur from the canvas's own document
  // and cache it — this only needs to run once per engine instance.
  gooBlurEl() {
    if (this._gooBlurEl) return this._gooBlurEl;
    const blur = resolveGooBlur(this.canvas, 'spelling-goo');
    if (blur) this._gooBlurEl = blur;
    return blur;
  }

  // Render exactly one frame — no rAF scheduling, no fps cap, no hidden-tab
  // skip. Used by the rAF loop above (via frame()) and by renderOnce() below,
  // which is the only entry point that must NOT arm a loop.
  renderFrame(now) {
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
    // so drive the blur from the rendered radius and hold the alpha threshold
    // (the SVG-filter analogue of contrast(26)) constant. The filter reference
    // itself is set once; only the blur's stdDeviation attribute updates here.
    if (!this.fltNow) { c.style.filter = 'url(#spelling-goo)'; this.fltNow = true; }
    const stdDev = (R * 0.71).toFixed(2);
    if (this.stdDevNow !== stdDev) {
      const blurEl = this.gooBlurEl();
      if (blurEl) blurEl.setAttribute('stdDeviation', stdDev);
      this.stdDevNow = stdDev;
    }

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
        } else if (!this.running && !this.frozen) {
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
  }

  // Render one settled frame with no scheduling — for prefers-reduced-motion,
  // where the caller sets `frozen = true` and wants a single static frame with
  // no rAF loop, no flow field, and no droplet budding.
  renderOnce() {
    this.size();
    this.renderFrame(performance.now());
  }
}
