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

## The one deliberate change: multi-line phrase reveal

The reference lays the phrase reveal out on **one line** at 112 units per character. `THE ONLY CONSTANT IS CHANGE` is 23 glyphs; on a 390px-wide phone that is ~17px per glyph, below the size at which the blur-and-threshold pipeline holds a stroke.

Phrase layout therefore becomes breakpoint-driven:

| viewport | canvas | reveal layout |
|---|---|---|
| ≥ 1024px | 430 × 430 | 1 line — `THE ONLY CONSTANT IS CHANGE` |
| 640–1023px | 380 × 380 | 2 lines — `THE ONLY CONSTANT` / `IS CHANGE` |
| < 640px | 300 × 225 (4:3) | 3 lines — `THE ONLY` / `CONSTANT` / `IS CHANGE` |

Rules:

- Breaks come from a **fixed break table** keyed by line count, not from measurement. Deterministic, never mid-word.
- Horizontal advance stays **112 units** per character. Line advance is **132 units** (112 + stroke clearance).
- Each line is centred horizontally about the block centre; the block is centred vertically about artboard centre `(60, 60)`.
- The bounding box of the fully laid-out block drives `viewScale` exactly as the single-line reveal does. Multi-line is only a different set of target coordinates — the framing lock, pairing, and collapse-back are untouched.
- Breakpoint is resolved once at mount and on resize; a resize mid-cycle re-lays out at the next reveal, it does not re-flow in flight.

## Point budgets

| | desktop | mobile (< 640px) |
|---|---|---|
| per spelled character | 900 | 600 |
| per phrase character | ~700 | ~700 |
| phrase cap | 7200 | 3600 |
| dormant mass | 420 | 420 |

## Sequence

Runs forever, no user input:

1. **Dormant** — endless morphing between formless low-harmonic masses, re-targeting at 72% of each morph so it never arrives.
2. **Spell** — for each character of `THE ONLY CONSTANT IS CHANGE`: morph to the glyph (620ms), hold (380ms). A space collapses to a sphere.
3. **Reveal** — the laid-out phrase resolves out of the final glyph over 2.6× the morph duration, plain interpolation.
4. **Collapse** — back to a dormant mass over 1.6× the morph, staying inside the framing lock.
5. Hold dormant ~2s, then return to step 2.

## Files

| path | what |
|---|---|
| `src/scripts/spelling-engine.js` | the port. One class, framework-free, no Astro coupling. Owns canvas, rAF loop, glyph cache, sequencer. |
| `src/components/Spelling.astro` | canvas element, sizing, mount/teardown. Imported by `index.astro`. |
| `public/glyphs/svg/*.svg` | the alphabet, copied unmodified from the handoff. |

`index.astro` gains the `<Spelling />` component between the `<h1>` wordmark and the `<p>` tagline. Nothing else on the page changes.

## Glyph loading

Only the unique glyphs in the tagline are fetched — `T H E O N L Y C S A I G` plus the space case, 13 files, a few KB. Fetched lazily on first need, parsed once, geometry cached per character. Wrapper transforms are flattened (composing translate, multiplying scale) and baked into coordinates per the README. Unmapped characters are skipped, not substituted.

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
