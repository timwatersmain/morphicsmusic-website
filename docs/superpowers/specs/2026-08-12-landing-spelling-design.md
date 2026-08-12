# Landing page — Spelling animation

**Date:** 2026-08-12
**Scope:** Port the Morphics *Spelling* metaball glyph engine onto `/` (`src/pages/index.astro`), below the wordmark, looping the tagline forever.

---

## Goal

The landing page currently shows a static wordmark, the tagline "The only constant is change.", and an ENTER button. Add a live canvas band between the wordmark and the tagline in which a single white fluid mass spells the tagline out one glyph at a time in the Morphics constructed alphabet, resolves into the whole phrase, collapses back to a formless dormant mass, and starts over — endlessly.

## Source of truth

`~/Downloads/design_handoff_spelling/` (identical to `Morphics abstract alphabet system (6).zip`):

| file | role |
|---|---|
| `README.md` | the specification. Authoritative for every constant and behaviour. |
| `Spelling.dc.html` | working design reference. Engine is the `<script data-dc-script>` block; `CHARMAP` lives here. |
| `support.js` | prototype runtime scaffolding. **Not ported.** |
| `glyphs/svg/*.svg` | the alphabet. Copied as-is. |

The README's "Calibrated constants" table and the framing-lock / pairing / sprite / blur rules are load-bearing and are ported verbatim. Where this spec is silent, the README governs.

## What is NOT ported

The prototype's UI chrome, all of which the README marks as optional scaffolding:

- header bar (`Morphics · spelling` + status readout)
- control panel: phrase input, `spell`/`stop` button, preset chips
- the behaviour lab and `lockMode`

No status readout appears on the landing page. The existing Latin `<p>` tagline is the translation of the glyphs and stays exactly as it is today.

## Phrase layout: the code, not the README

**The README is wrong about the reveal and the code is right.** The README states the phrase resolves on one line at 112 units per character. The shipped `phrasePoints` in `Spelling.dc.html` does something else, and it is what the reference actually looks like on screen:

- `const lines = words` — **one word per line**, always. A word never breaks.
- Advance `ADV = 92`, line lead `LEAD = 100`.
- Scale auto-fits the artboard: `s = min(0.72, 120 / (L * ADV), 110 / (rows * LEAD))` where `L` is the longest line length and `rows` the line count.
- View scale is then derived from the **measured canvas**, not a constant:
  `vs = clamp(0.6, 2.6, (min(CW, CH) / 2 - Rpx - 8) / half)` — which guarantees a phrase of any length fits the raster instead of being sliced by it.

So `THE ONLY CONSTANT IS CHANGE` already renders as five stacked lines that self-fit at any canvas size. **No breakpoint table, no break table, no layout changes are needed.** The port carries `phrasePoints` across unmodified.

The mobile adaptation is therefore only sizing and budget:

| viewport | canvas (CSS px) | phrase point cap |
|---|---|---|
| ≥ 1024px | 430 × 430 | 7200 |
| 640–1023px | 380 × 380 | 7200 |
| < 640px | 300 × 300 | 3600 |

The canvas stays **square at every breakpoint** — `phrasePoints` fits to `min(CW, CH)`, so a non-square box buys nothing and costs filter area. Backing store is set with `dpr = 1` deliberately, as the reference does: the form is heavily blurred, so backing-store resolution is never visible, and CSS filters apply at display scale.

## Point budgets

| | desktop | mobile (< 640px) |
|---|---|---|
| per spelled character (`N_LETTER`) | 900 | 600 |
| per phrase character | `700 × charCount`, clamped 360–760 per glyph | same |
| phrase cap (`N_MAX`) | 7200 | 3600 |
| dormant mass (`N_IDLE`) | 420 | 420 |

## Sequence

The reference's `run()` executes **once** and stops. Looping is the port's own addition. The cycle, forever, with no user input:

1. **Dormant** — endless morphing between formless low-harmonic masses, re-targeting at 72% of each morph so it never arrives. Driven by `idleTick`.
2. **Spell** — for each character of `THE ONLY CONSTANT IS CHANGE`: morph to the glyph (`morphMs` 620ms), hold (`hold` 380ms), behaviour picked at random and never repeating back-to-back. A space morphs to a sphere with `implode` and waits `morphMs + 120`.
3. **Reveal** — the laid-out phrase resolves out of the final glyph over `morphMs × 1.5` on `direct`, then `frozen = true` for `hold × 4`.
4. **Collapse** — back to a dormant mass over `morphMs × 1.9` (the `exiting` path), staying inside the framing lock.
5. Hold dormant **2000ms**, then return to step 2.

The loop must be cancellable: a single `stopped` flag checked at every `await` boundary, so teardown, off-screen pause, and tab-hide can halt it without leaving an orphaned `setTimeout` or a half-finished cycle.

## Files

| path | what |
|---|---|
| `src/scripts/spelling-engine.js` | the port. One class, framework-free, no Astro coupling. Owns canvas, rAF loop, glyph cache, sequencer. |
| `src/components/Spelling.astro` | canvas element, sizing, mount/teardown. Imported by `index.astro`. |
| `public/glyphs/svg/*.svg` | the alphabet, copied unmodified from the handoff. |

`index.astro` gains the `<Spelling />` component between the `<h1>` wordmark and the `<p>` tagline. Nothing else on the page changes.

## Glyph loading

Only the unique glyphs in the tagline are fetched — `T H E O N L Y C S A I G`, 12 files, a few KB. Fetched lazily on first need from `/glyphs/svg/<id>.svg` (the reference uses a relative `glyphs/svg/` path; it becomes root-absolute here), parsed once with `flatten()`, geometry cached per `CHARMAP` id. Wrapper transforms are flattened (composing translate, multiplying scale) and baked into coordinates. Unmapped characters are skipped, not substituted.

`CHARMAP` is ported whole even though the tagline needs 12 entries — it is a lookup table, it costs nothing, and it keeps the engine reusable for other phrases without a code change.

## Performance and guards

- Sim capped near 48fps (`if (now - last < 20) return`).
- Loop skipped entirely when `document.hidden`.
- `IntersectionObserver` pauses the loop when the canvas scrolls out of view and resumes on re-entry.
- Canvas backing store sized to its **measured layout size** — a larger backing store makes the CSS filter act many times stronger and melts the form.
- Scratch `Float32Array`s reused; no per-frame allocation.
- `prefers-reduced-motion: reduce` → render the settled phrase once, statically, with the flow field and droplet budding off, and never start the loop.

## Verification

Per the README, verify by measuring rather than by eye: rasterise a settled glyph, threshold it, and compare against the source SVG rendered at the same size. Intersection-over-union should reach ~0.90.

Additionally:

- All three breakpoints render the full reveal with no clipping and no glyph overlap.
- A full cycle completes and returns to dormant without the mass drifting or growing (framing lock holding across the collapse).
- Reduced-motion path starts no rAF loop.
- Off-screen and hidden-tab paths stop consuming frames.

## Out of scope

- The spelling engine anywhere other than `/`.
- Any user-facing control over the phrase, timing, or behaviour.
- A decoder key or glyph legend on the site.
- Changes to the wordmark, tagline copy, or ENTER button.

---

Morphics · the only constant is change
