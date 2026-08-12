# Landing Spelling Animation — Task 8 Verification Results

Ran `npm run build && node scripts/verify-spelling.mjs` on `feat/landing-spelling`, 2026-08-12.
`chrome-headless-shell` (v1208, `--headless --remote-debugging-port=9333`), driven over CDP.

## IoU vs source SVG

Method: for each unique glyph in `THEONLYCONSTANTISCHANGE`, an isolated `SpellingEngine`
instance renders that glyph settled (`frozen = true`, `dur = 1`, `t0` in the past, a single
`renderFrame()` call — no rAF loop, no wobble, no droplet budding). The canvas's own
`c.style.filter` (set by the engine: `blur(Rpx) contrast(26) brightness(1.03)`) is read back
via `ctx.filter` on a second canvas to reproduce exactly what the compositor shows, thresholded
at `red > 127`. The reference is the source SVG (`/glyphs/svg/<ch>.svg`) rendered as an `<img>`
into a canvas of the same 430×430 size, scaled to `SIZE * 0.66` and centred — the same scale
and centre the engine uses to map its 120×120 artboard onto the canvas at rest (`vScale = 1`).

**Authoritative run** (worst-to-best):

| glyph | IoU | engine bbox (w×h) | svg bbox (w×h) |
|---|---|---|---|
| O | 0.772 | 188×174 | 190×182 |
| T | 0.842 | 180×173 | 189×183 |
| H | 0.843 | 177×175 | 188×185 |
| N | 0.849 | 183×175 | 185×184 |
| I | 0.856 | 183×177 | 190×187 |
| A | 0.858 | 186×185 | 188×186 |
| G | 0.859 | 186×169 | 190×180 |
| C | 0.863 | 178×183 | 187×186 |
| L | 0.865 | 183×179 | 189×184 |
| E | 0.869 | 187×179 | 190×180 |
| S | 0.880 | 179×183 | 189×187 |
| Y | 0.887 | 138×179 | 144×185 |

**Worst: 0.772 (O). Median: 0.859. Result: FAIL — worst IoU is below the 0.85 gate**, and
every glyph is below the design handoff's ~0.90 target. `node scripts/verify-spelling.mjs`
exits 1.

This was run 5 times across script iterations (values shift a few points run-to-run — see
"Run-to-run variance" below) and the pattern was consistent every time: **O is always the
worst glyph** (0.72–0.79 across runs), most letters cluster in the high 0.7s to high 0.8s, and
no letter has ever reached 0.90.

### Diagnosis — this is a real measurement, not a script bug

Bounding boxes agree closely between engine and SVG renders (within ~1–8px on a ~190px feature,
i.e. within about 1–5%), which rules out a scale or centring mismatch — the two masks describe
the same thing at the same scale, as required. The `diff` visualisation (engine-only in green,
SVG-only in red, both in white — see `/tmp/spelling-O-diff.png` from this session, not
committed) shows a thin red rim around **every** feature — the big ring, the small dots, the
crescents alike — consistent with a uniform ~2–4px erosion of the reconstructed stroke, not a
directional offset or a hole/gap defect.

To rule out the read-back method itself as the source of the discrepancy, the same settled `O`
was rendered two ways and compared: (1) the emulated method above (`ctx.filter` + `drawImage`
on an off-screen canvas), and (2) the canvas placed visibly in the page and captured with a real
`Page.captureScreenshot` over CDP (the actual browser compositor applying the actual CSS
filter). The two were visually identical, pixel for pixel. **The read-back method faithfully
reproduces what the browser actually paints** — the thinness is a property of the real,
production-built render, not an artifact of this measurement technique.

**Finding to report, not fix:** as built and calibrated per the plan (constants verified
unchanged: `HALF = 6.5`, sprite radius `min(W,H) * 0.66 * (HALF/120) * 0.90`, sprite diameter
`R * 2.24`, gradient stops `1.0/1.0@0.86/0.5@0.94/0@1.0`, filter
`blur(R*0.71) contrast(26) brightness(1.03)`), the settled glyph mass reconstructs measurably
thinner than the source SVG's 13-unit stroke, most severely on `O` (large closed curves) and
least on `Y`/`S` (already open, asymmetric forms). The shapes are correct and clearly legible —
this is a thinness/area shortfall, not a geometry or positioning bug — but it keeps every
glyph below the design handoff's own ~0.90 target, and `O` specifically below the 0.85 pass
gate on every run observed. Per the task's constraints this was not adjusted in the engine, and
the measurement was not loosened to make it agree.

### Run-to-run variance

Because the settled frame still carries the engine's breathing/bob offset (`breathe`, `bobX`,
`bobY` in `renderFrame`, all keyed off `this.freezeAt`, which is set to `performance.now()` the
first time a given engine instance renders while frozen), the exact sub-pixel phase differs
between runs even with everything else identical. This shifts IoU by roughly ±0.02–0.05 per
glyph between runs without changing the qualitative picture (O worst, most letters high-0.7s to
high-0.8s, none reaching 0.90). This is intrinsic to the engine's own settled-frame behaviour,
not a flaw in the harness — a truly static, phase-locked reference would require freezing
`freezeAt` at a specific fixed value, which was not done here since it isn't how the shipped
engine actually renders a "settled" letter.

## Guard checks (Step 4)

Automated as far as possible over CDP against the real built page in `dist/`, using only
black-box observation (canvas pixel fingerprinting, `document.hidden` override,
`prefers-reduced-motion` emulation, DOM scroll/spacer manipulation in the test session) —
nothing under `src/scripts/spelling/` or `src/components/` was touched or instrumented.

| check | result | evidence |
|---|---|---|
| **Loop repeats** | **PASS** | Sampled the live `#spelling` canvas every 500ms for 75s (real production timings, not accelerated). Detected two "settled phrase" plateaus — runs of consecutive identical fingerprints, matching the `frozen = true` hold (`holdMs * 4` = 1520ms) that the phrase reveal ends on — at t≈27.3s and t≈59.7s, a gap of ≈32.4s. That gap is consistent with one full cycle (23 letters × ~1s + phrase reveal + hold + dormant tail + `restMs` ≈ 2s ≈ 30–33s by hand calculation from the constants), i.e. the loop visibly repeated within the observation window. |
| **Off-screen pause (IntersectionObserver)** | **PASS** | `index.astro`'s hero section is the entire page by design (no content below the fold), so the canvas doesn't naturally leave a normal viewport — a 2400px spacer div was inserted at the top of `<body>` in the live test session (DOM-only, not a source change) to create real scroll room. With the canvas scrolled into view, 3 fingerprints 300ms apart differed (animating). Scrolled fully away (canvas ~2645px down, well outside any viewport), 4 fingerprints 300ms apart were identical (frozen). Scrolled back into view, 3 fingerprints differed again (resumed). |
| **Hidden-tab skip (`document.hidden`)** | **PASS** | Overrode `document.hidden` to return `true` and dispatched `visibilitychange` — `frame()` reads `document.hidden` live each tick, so this exercises the real guard without needing an actual OS-level tab switch. 4 fingerprints 300ms apart while "hidden" were identical (frozen). Restored to `false` — 3 fingerprints differed again (resumed). **Not independently verified:** "no burst of catch-up frames" specifically — that would need the Performance/Tracing CDP domain to count actual renders across the transition. By code inspection, `frame()` has no catch-up queue (it only reads the live `document.hidden` value each `requestAnimationFrame` tick and returns early), so a burst is not structurally possible — but that inference was not measured here. |
| **`prefers-reduced-motion` → static frame** | **PASS** | Set `Emulation.setEmulatedMedia` to `prefers-reduced-motion: reduce` before navigating, plus a `Page.addScriptToEvaluateOnNewDocument` hook counting `window.requestAnimationFrame` calls (external observation, not a source instrumentation). After load+settle, 4 fingerprints 400ms apart were identical (static, matching the code path in `Spelling.astro` that calls `engine.renderOnce()` once and never `engine.start()`), and the rAF counter stayed at 0. `performance.getEntriesByType('measure')` was empty in **both** modes, because this codebase never calls `performance.mark`/`measure` — that specific instruction from the brief doesn't distinguish anything here; canvas staleness is the operative evidence instead. |

## Files

- `scripts/verify-spelling.mjs` — the verification script (new).
- This file.

## Note on `dist/` vs `src/` for the IoU harness

Astro bundles and hashes `src/scripts/spelling/*.js` into `dist/_astro/*.js` with renamed
exports, so `import('/scripts/spelling/engine.js')` — as sketched in the task brief — cannot be
served unbundled straight out of `dist/`; that exact path doesn't exist there. The script
serves the engine modules directly from `src/` over a dedicated `/__spelling_src__/` route
(they're already plain ESM with relative imports, so they run unmodified in a browser) for the
IoU harness only. Glyph SVGs and the real page used for the guard checks are served from
`dist/` as actually built.
