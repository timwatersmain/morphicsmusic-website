/* ────────────────────────────────────────────────────────────────────────────
 * LIQUID GLASS — standalone
 * Extracted from PHORM LIVE's SIGNAL WALL channel `liquid_glass` (fx12).
 * Source of truth: ~/morphics-fx/signal_wall.js. The field/contour math below is
 * VERBATIM from there; only the host wiring is new (own rAF loop, own source
 * raster, own canvas sizing) so it has zero dependency on the VJ app.
 *
 * Canvas 2D only — no WebGL, no ctx.filter, no external libraries.
 *
 *   <canvas id="lg"></canvas>
 *   <video id="clip" src="clip.mp4" muted loop playsinline autoplay></video>
 *   <script src="liquid-glass.js"></script>
 *   <script>
 *     const lg = LiquidGlass.attach(document.getElementById('lg'), {
 *       source: document.getElementById('clip')
 *     });
 *   </script>
 *
 * The source may be a <video>, <img>, or another <canvas>. A cross-origin video
 * TAINTS the canvas — harmless here (nothing reads pixels back), but it means you
 * can't call canvas.toDataURL() on the output.
 * ──────────────────────────────────────────────────────────────────────────── */
(function (root) {
'use strict';

// Surface threshold for the compact-support kernel (1-q^2)^3. RSCALE converts a lobe's
// intended radius into the kernel's support radius, so a LONE lobe's surface lands
// exactly where you asked whatever T is — T then controls only how far the kernel
// REACHES, i.e. how strongly separated masses bulge toward each other before they touch.
var LAVA_T = 0.55, LAVA_RSCALE = 1 / Math.sqrt(1 - Math.pow(0.55, 1 / 3));

function LiquidGlass(canvas, opts) {
  opts = opts || {};
  this.canvas = canvas;
  this.g = canvas.getContext('2d');
  this.SW = 512; this.SH = 288;                 // shared source raster
  this.srcC = document.createElement('canvas');
  this.srcC.width = this.SW; this.srcC.height = this.SH;
  this.srcX = this.srcC.getContext('2d');

  this.media = opts.source || null;
  this.speed = opts.speed == null ? 1 : opts.speed;         // motion rate
  this.intensity = opts.intensity == null ? 1 : opts.intensity;  // beat response depth
  this.vignette = opts.vignette !== false;                  // the shared finish pass
  this.dpr = opts.dpr || (root.devicePixelRatio || 1);
  this.maxDpr = opts.maxDpr || 2;                           // cap: this is CPU work
  // RENDER-RESOLUTION CAP. This is CPU Canvas 2D — the field scatter and the marching
  // squares both scale with pixel area, and measured on a 4-core iMac: 640x360 = 5.8ms,
  // 1280x720 = 24ms, 1280x720 @dpr2 = 60ms. A full-bleed hero at native devicePixelRatio
  // will not hold 60fps anywhere. So the internal buffer is capped at maxRenderWidth px
  // and the browser scales it up to the element's CSS size — the effect is soft-edged
  // molten shapes, so the upscale is invisible. Raise it if you have the headroom.
  this.maxRenderWidth = opts.maxRenderWidth || 900;
  this.beat = 0;                                            // 0..1, set it per frame if you want pulse
  this.autoResize = opts.autoResize !== false;

  this.st = {};                                             // effect scratch (bags, blobs, field)
  this._raf = 0; this._t0 = 0; this._err = 0; this._w = 0; this._h = 0;
  this._onResize = this._resize.bind(this);
  this._frame = this._frame.bind(this);

  this._resize();
  if (this.autoResize) {
    root.addEventListener('resize', this._onResize);
    if (root.ResizeObserver) { this._ro = new ResizeObserver(this._onResize); this._ro.observe(canvas); }
  }
  if (opts.autoStart !== false) this.start();
}

LiquidGlass.prototype = {

  /* ── public ─────────────────────────────────────────────────────────────── */
  setSource: function (m) { this.media = m; return this; },
  /* fresh random configuration — new blob count, sizes, heat */
  reroll: function () { this.st = {}; return this; },
  start: function () { if (!this._raf) { this._t0 = 0; this._raf = requestAnimationFrame(this._frame); } return this; },
  stop: function () { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; } return this; },
  destroy: function () {
    this.stop();
    root.removeEventListener('resize', this._onResize);
    if (this._ro) this._ro.disconnect();
    this.st = {}; this.media = null;
  },

  /* ── host wiring ────────────────────────────────────────────────────────── */
  _resize: function () {
    var c = this.canvas, dpr = Math.min(this.maxDpr, this.dpr);
    var w = c.clientWidth || c.width || 640, h = c.clientHeight || c.height || 360;
    if (this.maxRenderWidth && w * dpr > this.maxRenderWidth) dpr = this.maxRenderWidth / w;
    var pw = Math.max(4, Math.round(w * dpr)), ph = Math.max(4, Math.round(h * dpr));
    if (c.width !== pw || c.height !== ph) {
      c.width = pw; c.height = ph;
      this.st = {};                 // scratch buffers are size-bound — a resize clears state
    }
    this._w = w; this._h = h; this._dprEff = dpr;
  },

  /* one shared source raster per frame, cover-fit */
  _tick: function () {
    var g = this.srcX, W = this.SW, H = this.SH, m = this.media;
    if (m && (m.videoWidth || m.width)) {
      var mw = m.videoWidth || m.width, mh = m.videoHeight || m.height;
      var s = Math.max(W / mw, H / mh), dw = mw * s, dh = mh * s;
      try { g.drawImage(m, (W - dw) / 2, (H - dh) / 2, dw, dh); } catch (e) {}
    } else {
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    }
  },

  _frame: function (ms) {
    this._raf = requestAnimationFrame(this._frame);
    if (!this._t0) this._t0 = ms;
    var t = (ms - this._t0) / 1000;
    if (this.autoResize) this._resize();
    this._tick();
    this.draw(t, this.beat);
  },

  /* render one frame. Call it yourself (with autoStart:false) to drive from your own loop. */
  draw: function (t, beat) {
    var g = this.g, w = this._w, h = this._h, dpr = this._dprEff;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    var o = { spd: this.speed, amt: this.intensity, dpr: dpr };
    try {
      this.fx12(g, w, h, t, beat || 0, this.st, o);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      if (this.vignette) {
        var vg = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.28, w / 2, h / 2, Math.max(w, h) * 0.72);
        vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
        g.fillStyle = vg; g.fillRect(0, 0, w, h);
      }
    } catch (err) { if (!this._err) { this._err = 1; console.error('[liquid_glass]', err); } }
  },

  /* ══════ effect math below — VERBATIM from signal_wall.js, do not retune ══════ */

  h: function (n) { var s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); },

  /* re-rolls a bag of params at irregular intervals; lerps toward the new bag */
  bag: function (s, t, key, lo, hi, gen) {
    var b = s[key];
    if (!b) { b = s[key] = { cur: gen(), next: gen(), t0: t, t1: t + lo + Math.random() * (hi - lo) }; }
    if (t > b.t1) {
      b.cur = b.next; b.next = gen();
      b.t0 = t; b.t1 = t + lo + Math.random() * (hi - lo);
    }
    var u = Math.min(1, Math.max(0, (t - b.t0) / (b.t1 - b.t0)));
    var e = u * u * (3 - 2 * u), out = {};
    for (var k in b.cur) out[k] = b.cur[k] + (b.next[k] - b.cur[k]) * e;
    return out;
  },

  /* ---------- 13 liquid glass — MOLTEN ----------
   * A lava lamp run HOT: formless morphing masses that contort, stretch and squeeze past
   * each other. Discrete ellipses can't do that — the defining behaviour is blobs MERGING
   * and NECKING, which needs a scalar field. So: an anisotropic metaball field contoured
   * with marching squares, at two thresholds (outer silhouette + inner core). Blobs stretch
   * along their own velocity; the field does the merging for free.
   */
  _lavaField: function (s, w, h, t, o) {
    var self = this;
    var p = this.bag(s, t, 'p', 12, 26, function () {
      return {
        n: 5 + Math.floor(Math.random() * 4),
        size: 0.072 + Math.random() * 0.055,
        heat: 0.5 + Math.random() * 0.45,           // global agitation
        churn: 0.5 + Math.random() * 0.9
      };
    });
    var N = Math.round(p.n), i, k, j;
    if (!s.blobs || s.blobs.length !== N) {
      s.blobs = [];
      for (i = 0; i < N; i++) {
        var ii = i, hx = function (kk) { return self.h(ii * 9.7 + kk); };
        s.blobs.push({
          x: 0.12 + hx(0) * 0.76, y: 0.12 + hx(1) * 0.76,
          vx: (hx(2) - 0.5) * 0.05, vy: (hx(3) - 0.5) * 0.05,
          r0: 0.62 + hx(4) * 0.8,                    // relative size
          rate: 0.18 + hx(6) * 0.26,                 // its own breathing
          wob: hx(7) * 0.5, seed: i * 9.7,
          // ACCUMULATED phases — everything oscillatory integrates dt (see the stepper).
          // Seeded apart so the blobs never breathe in unison.
          pu: hx(5) * 6.283, orb: hx(8) * 6.283,
          dir: hx(9) * 6.283, turn: (hx(10) - 0.5) * 0.35,  // heading + how fast it wanders
          el: 1,
          // ONE phase per sub-lobe at INCOMMENSURATE rates. Sharing a single orbit phase
          // locked the lobes into a harmonic relationship and the silhouette cycled —
          // that is the "rigid" read. Independent rates never resynchronise.
          sp: Float64Array.from({ length: 6 }, function (_, kk) { return hx(20 + kk) * 6.283; }),
          srt: Float64Array.from({ length: 6 }, function (_, kk) { return 0.20 + hx(30 + kk) * 0.42; }),
          sax: Float64Array.from({ length: 6 }, function (_, kk) { return hx(40 + kk) * 6.283; }),
          sar: Float64Array.from({ length: 6 }, function (_, kk) { return (hx(50 + kk) - 0.5) * 0.5; }),
          // DEFORM clocks, separate from the orbit clocks and much faster: the shape has to
          // churn on its own timescale, or slowing the travel also freezes the silhouettes.
          sd: Float64Array.from({ length: 6 }, function (_, kk) { return hx(60 + kk) * 6.283; }),
          sdr: Float64Array.from({ length: 6 }, function (_, kk) { return 0.85 + hx(70 + kk) * 1.35; })
        });
      }
      s.lt = t;
    }
    // ── the stepper ───────────────────────────────────────────────────────────
    // Every phase is INTEGRATED (`+= dt * rate`), never `t * <bag parameter>`: bag() lerps
    // its params continuously and t runs into the hundreds of seconds, so d(phase) =
    // t * d(param) — a 0.001 drift in heat moves the phase 0.3 rad per frame at t=300.
    // That was the jitter, and it got worse the longer it ran. Do not reintroduce `t *`
    // on anything bag() controls.
    var dt = Math.min(0.05, Math.max(0.001, t - (s.lt === undefined ? t - 0.033 : s.lt)));
    s.lt = t;
    var heat = p.heat * o.spd;
    s.cph = (s.cph || 0) + dt * heat * p.churn * 0.30;        // shared convection phase
    for (i = 0; i < N; i++) {
      var b = s.blobs[i];
      b.pu += dt * heat * b.rate;                             // breathing
      b.orb += dt * heat * 0.34;                              // sub-lobe orbit
      b.dir += dt * heat * (b.turn + 0.18 * Math.sin(s.cph * 1.7 + b.seed));   // heading wanders
      for (k = 0; k < 6; k++) {
        b.sp[k] += dt * heat * b.srt[k] * 1.5;                // orbit
        // the deform RATE itself drifts, so no lobe is ever exactly periodic. Safe to
        // modulate because the PHASE is integrated, not computed from t.
        b.sd[k] += dt * heat * b.sdr[k] * (1 + 0.38 * Math.sin(s.cph * 0.63 + k * 1.27 + b.seed));
      }
      // DRIVE: a heading that turns slowly, so each segment actually travels across the
      // frame instead of vibrating in place. Damping is light so they coast.
      var drive = 0.052;
      b.vx += (Math.cos(b.dir) * drive + Math.sin(s.cph + b.seed) * 0.035 - b.vx * 0.42) * dt * heat * 2.2;
      b.vy += (Math.sin(b.dir) * drive * 0.8 + Math.cos(s.cph * 0.8 + b.seed * 1.7) * 0.045 - b.vy * 0.42) * dt * heat * 2.2;
      // blobs push off each other — this is what makes them squeeze PAST rather than through
      for (j = 0; j < N; j++) {
        if (j === i) continue;
        var c = s.blobs[j], dx = b.x - c.x, dy = b.y - c.y;
        var d2 = dx * dx + dy * dy + 1e-4;
        if (d2 < 0.085) { var f = (0.085 - d2) * 0.75 * dt * heat / Math.sqrt(d2); b.vx += dx * f; b.vy += dy * f; }
      }
      b.x += b.vx * dt * heat; b.y += b.vy * dt * heat;
      // SOFT walls. A hard bounce (clamp + flip velocity) is a discontinuity — it read as
      // a snap every time a blob reached an edge. This eases them back instead.
      var push = function (v, lo, hi) { return v < lo ? (lo - v) : (v > hi ? (hi - v) : 0); };
      b.vx += push(b.x, 0.10, 0.90) * dt * heat * 9.0;
      b.vy += push(b.y, 0.12, 0.88) * dt * heat * 9.0;
    }
    // ── sample the field ──
    // Grid resolution is a PERFORMANCE dial, not the smoothness dial — scatter cost scales
    // with density, and 10px cells measured 25ms/frame. Smoothness comes from the contour
    // stitcher (_lavaLoops/_lavaSmooth) instead.
    var cols = Math.max(28, Math.min(120, Math.round(w / 9.5)));
    var rows = Math.max(14, Math.round(cols * h / w));
    // ONE CELL OF GUARD BAND on every side, forced empty. Without it a mass touching the
    // frame edge produces an OPEN polyline — the stitcher can't close it, and closePath()
    // then draws a straight chord across the blob. The guard ring sits just off-screen, so
    // every contour closes out of view and masses still appear to run off the edge.
    var gw = cols + 3, gh = rows + 3;
    if (!s.fld || s.fld.length !== gw * gh) { s.fld = new Float32Array(gw * gh); }
    var F = s.fld, R = Math.min(w, h) * p.size;
    // Each blob contributes SIX orbiting sub-lobes rather than one centre: a single
    // metaball term is always a clean ellipse, which reads as a bubble, not as molten
    // anything. Per-lobe axes and clocks keep the silhouette lumpy and reforming even when
    // a blob is alone in the frame.
    var B = [], CEN = [];
    for (i = 0; i < N; i++) {
      var bl = s.blobs[i];
      // ONE slow harmonic plus a gentler second at a FIXED ratio. Two fast harmonics
      // scaled by a drifting `heat` was what made the sizes flap.
      var puls = 1 + 0.24 * Math.sin(bl.pu) + 0.10 * Math.sin(bl.pu * 0.41 + 1.3);
      var spd = Math.hypot(bl.vx, bl.vy);
      // elongation is LOW-PASSED, not read straight off velocity — the repulsion term
      // changes velocity every frame, and feeding that to the shape made it shimmer
      bl.el += (1 + Math.min(1.0, spd * 4.5) * (0.30 + bl.wob * 0.6) - bl.el) * Math.min(1, dt * 2.0);
      var base = R * bl.r0 * puls;
      CEN.push({ x: bl.x * w, y: bl.y * h, r: base });
      var K = 6;
      for (k = 0; k < K; k++) {
        var ph = bl.sp[k], d1 = bl.sd[k];
        // The lobe doesn't just orbit — it swings about that orbit, reaches in and out, and
        // swells and shrinks, each on its own clock. Pure rotation reads as a rigid body
        // turning; it's the OFFSET and RADIUS churning that makes it look like fluid.
        var ang = ph + 0.72 * Math.sin(d1 * 0.47 + k * 1.1);
        var off = base * (0.13 + 0.46 * (0.5 + 0.5 * Math.sin(d1 + k * 1.31 + bl.seed))
                               + 0.11 * Math.sin(d1 * 1.73 + k * 2.7));
        var rk = base * (0.40 + 0.38 * (0.5 + 0.5 * Math.sin(d1 * 0.83 + k * 1.9 + bl.seed * 1.3))
                              + 0.09 * Math.sin(d1 * 2.31 + k * 0.7));
        // TRAIL: lobes lag behind the centre along the direction of travel, progressively.
        // A moving droplet stretches BEHIND itself — the fluid cue a symmetric ellipse
        // can't give.
        var lag = base * Math.min(1.4, spd * 9.0) * (0.18 + 0.62 * k / K);
        var ux = spd > 1e-5 ? bl.vx / spd : 0, uy = spd > 1e-5 ? bl.vy / spd : 0;
        var la = bl.sax[k] + ph * bl.sar[k] + 0.5 * Math.sin(d1 * 0.39 + k);  // axis, turning + swaying
        var el2 = 1 + 0.62 * (0.5 + 0.5 * Math.sin(d1 * 0.61 + k * 2.4));     // its own squash, churning
        B.push({
          x: bl.x * w + Math.cos(ang) * off - ux * lag,
          y: bl.y * h + Math.sin(ang) * off * 0.85 - uy * lag,
          R: rk * LAVA_RSCALE, ca: Math.cos(la), sa: Math.sin(la),
          ex: el2 * bl.el, ey: 1 / Math.sqrt(el2)
        });
      }
    }
    // ── accumulate the field ──────────────────────────────────────────────────
    // COMPACT-SUPPORT kernel (Wyvill: (1-q^2)^3 inside its radius, 0 outside) rather than
    // the classic r^2/d^2. They look identical — same merging, same necking — but 1/d^2 has
    // an INFINITE tail, so every lobe had to be summed against every grid point (612k
    // iterations a frame, 14ms). Finite support means each lobe only writes the cells it can
    // reach, so this SCATTERS into a bounding box instead of gathering.
    F.fill(0);
    var cw2 = w / cols, ch2 = h / rows;
    // grid point (gx,gy) lives at world ((gx-1)*cw2, (gy-1)*ch2) — index 0 is the guard ring
    for (i = 0; i < B.length; i++) {
      var bb = B[i];
      var Rk = bb.R, ext = Rk * Math.max(bb.ex, bb.ey);
      var gx0 = Math.max(1, Math.floor((bb.x - ext) / cw2) + 1), gx1 = Math.min(gw - 2, Math.ceil((bb.x + ext) / cw2) + 1);
      var gy0 = Math.max(1, Math.floor((bb.y - ext) / ch2) + 1), gy1 = Math.min(gh - 2, Math.ceil((bb.y + ext) / ch2) + 1);
      var iR2 = 1 / (Rk * Rk);
      for (var gy = gy0; gy <= gy1; gy++) {
        var dy2 = (gy - 1) * ch2 - bb.y, row = gy * gw;
        for (var gx = gx0; gx <= gx1; gx++) {
          var dx3 = (gx - 1) * cw2 - bb.x;
          var u = (dx3 * bb.ca + dy2 * bb.sa) / bb.ex, v = (-dx3 * bb.sa + dy2 * bb.ca) / bb.ey;
          var q2 = (u * u + v * v) * iR2;
          if (q2 >= 1) continue;
          var k1 = 1 - q2;
          F[row + gx] += k1 * k1 * k1;
        }
      }
    }
    return { F: F, gw: gw, gh: gh, cols: gw - 1, rows: gh - 1, cw: cw2, ch: ch2,
             ox: -cw2, oy: -ch2, B: B, CEN: CEN };
  },

  // Marching squares -> CLOSED, DIRECTED loops -> smooth curves.
  // Filling each cell's inside-polygon independently tiles correctly, but the outline is
  // then a chain of straight chords one cell long, so the masses read faceted and rigid
  // however fluid the motion is. Raising the grid until the chords vanish costs far too
  // much. So the segments are STITCHED into closed loops and drawn as quadratic curves
  // through their midpoints — a C1 contour at the same grid cost. Fill and stroke share the
  // loops, so they can never disagree. One consistent segment direction convention is what
  // lets the loops close AND gives holes the opposite winding, so nonzero fill leaves them
  // empty.
  _lavaLoops: function (fd, T) {
    var F = fd.F, gw = fd.gw, cols = fd.cols, rows = fd.rows, cw = fd.cw, ch = fd.ch, ox = fd.ox, oy = fd.oy;
    var seg = [];                                   // flat [x1,y1,x2,y2, ...]
    for (var r = 0; r < rows; r++) {
      var y0 = oy + r * ch, y1 = y0 + ch, o0 = r * gw, o1 = (r + 1) * gw;
      for (var c = 0; c < cols; c++) {
        var v0 = F[o0 + c], v1 = F[o0 + c + 1], v2 = F[o1 + c + 1], v3 = F[o1 + c];
        var k = 0;
        if (v0 > T) k |= 8; if (v1 > T) k |= 4; if (v2 > T) k |= 2; if (v3 > T) k |= 1;
        if (k === 0 || k === 15) continue;
        var x0 = ox + c * cw, x1 = x0 + cw;
        var ax = x0 + cw * (T - v0) / (v1 - v0), ay = y0;                  // top
        var bx = x1, by = y0 + ch * (T - v1) / (v2 - v1);                  // right
        var cx2 = x0 + cw * (T - v3) / (v2 - v3), cy2 = y1;                // bottom
        var dx2 = x0, dy2 = y0 + ch * (T - v0) / (v3 - v0);                // left
        var A = [ax, ay], Bp = [bx, by], C = [cx2, cy2], D = [dx2, dy2];
        var S = function (pp, qq) { seg.push(pp[0], pp[1], qq[0], qq[1]); };
        switch (k) {
          case 1:  S(D, C); break;   case 2:  S(C, Bp); break;
          case 3:  S(D, Bp); break;  case 4:  S(Bp, A); break;
          case 5:  S(D, A); S(Bp, C); break;                 // saddle
          case 6:  S(C, A); break;   case 7:  S(D, A); break;
          case 8:  S(A, D); break;   case 9:  S(A, C); break;
          case 10: S(A, Bp); S(C, D); break;                 // saddle
          case 11: S(A, Bp); break;  case 12: S(Bp, D); break;
          case 13: S(Bp, C); break;  case 14: S(C, D); break;
        }
      }
    }
    // stitch: an endpoint on a shared cell edge is computed from the same two corner values
    // by both neighbouring cells, so the coordinates match; quantise anyway.
    var key = function (x, y) { return Math.round(x * 16) * 65536 + Math.round(y * 16); };
    var byStart = new Map(), i;
    for (i = 0; i < seg.length; i += 4) {
      var kk = key(seg[i], seg[i + 1]);
      var arr = byStart.get(kk); if (arr) arr.push(i); else byStart.set(kk, [i]);
    }
    var used = new Uint8Array(seg.length >> 2), loops = [];
    for (i = 0; i < seg.length; i += 4) {
      if (used[i >> 2]) continue;
      var pts = [], cur = i;
      while (cur !== -1 && !used[cur >> 2]) {
        used[cur >> 2] = 1;
        pts.push(seg[cur], seg[cur + 1]);
        var cand = byStart.get(key(seg[cur + 2], seg[cur + 3]));
        cur = -1;
        if (cand) for (var q = 0; q < cand.length; q++) if (!used[cand[q] >> 2]) { cur = cand[q]; break; }
      }
      if (pts.length >= 8) loops.push(pts);            // 4+ points, else it's a speck
    }
    return loops;
  },

  // quadratic through the midpoints of a closed polyline — smooth, and it stays inside the
  // polyline's hull so the mass never bloats when the contour is smoothed
  _lavaSmooth: function (loops) {
    var P = new Path2D();
    for (var L = 0; L < loops.length; L++) {
      var pts = loops[L], n = pts.length >> 1;
      if (n < 3) continue;
      var px = pts[(n - 1) * 2], py = pts[(n - 1) * 2 + 1];
      P.moveTo((px + pts[0]) / 2, (py + pts[1]) / 2);
      for (var i = 0; i < n; i++) {
        var cx = pts[i * 2], cy = pts[i * 2 + 1];
        var j = (i + 1) % n, nx = pts[j * 2], ny = pts[j * 2 + 1];
        P.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2);
      }
      P.closePath();
    }
    return P;
  },

  fx12: function (g, w, h, t, b, s, o) {
    var fd = this._lavaField(s, w, h, t, o);
    var outer = this._lavaSmooth(this._lavaLoops(fd, LAVA_T));
    var core  = this._lavaSmooth(this._lavaLoops(fd, LAVA_T * 3.3));
    var self = this;
    g.drawImage(this.srcC, 0, 0, w, h);                     // clean plate
    var mass = function (mm, alpha, ox, oy) {
      g.save(); g.globalAlpha = alpha;
      g.translate(w / 2 + (ox || 0), h / 2 + (oy || 0)); g.scale(mm, mm); g.translate(-w / 2, -h / 2);
      g.drawImage(self.srcC, 0, 0, w, h); g.restore();
    };
    var beat = 1 + b * 0.05 * o.amt;
    // FLAT, 2D, no shading. Every rendered cue that implied a LIT SOLID is deliberately
    // absent — no per-lobe highlight/shadow gradient, no specular catchlight, no dark outer
    // rim. The silhouette shows the footage at a different magnification, plus one hairline
    // edge. Do not add shading back.
    g.save(); g.clip(outer); mass(1.5 * beat, 1, 0, 0); g.restore();
    // core: still flat — a second, stronger magnification, not a highlight
    g.save(); g.clip(core); mass(2.2 * beat, 1, 0, 0); g.restore();
    // edge: one flat hairline, no dark counter-stroke
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.lineWidth = Math.max(1, Math.min(w, h) * 0.0026);
    g.strokeStyle = 'rgba(255,255,255,0.34)'; g.stroke(outer);
    g.strokeStyle = 'rgba(255,255,255,0.13)'; g.lineWidth = Math.max(1, Math.min(w, h) * 0.002);
    g.stroke(core);
  }
};

LiquidGlass.attach = function (canvas, opts) { return new LiquidGlass(canvas, opts); };

if (typeof module === 'object' && module.exports) module.exports = LiquidGlass;
root.LiquidGlass = LiquidGlass;

})(typeof window !== 'undefined' ? window : this);
