# Landing page — scramble grid (v2)

**Date:** 2026-08-12
**Supersedes:** the sequencer half of `2026-08-12-landing-spelling-design.md`. The render pipeline from that spec is unchanged and carries over.

---

## What changes and why

v1 put a single fluid mass on the landing page that spelled the tagline one glyph at a time, resolved the whole phrase, collapsed to a dormant blob, and looped. It works, but the payoff sits ~24 seconds into a 48-second cycle — longer than a landing-page visit. Most visitors saw three random glyphs and left.

v2 replaces the sequencer with a **scramble grid**: the whole phrase is present at all times as a fixed rectangular field of independently morphing glyph cells. Every cell continuously morphs between random letters. Hovering ENTER resolves every cell into its true letter, spelling the phrase; leaving returns them to scrambling.

The motion is visible instantly, the phrase is always one hover away, and the ENTER button acquires meaning: chaos resolving into `THE ONLY CONSTANT IS CHANGE`.

## What carries over unchanged

Everything below the sequencer, all of it already built, reviewed, and measured:

- `charmap.js`, `glyph-parse.js` — the character map and SVG transform flattener
- `sampling.js` — arc-length-proportional point sampling via the offscreen SVG probe
- `pairing.js` — 24-sector `assign()` and `box()`
- `shapes.js` — easing curves (`spherePoints`/`blobShape` become unused by the landing page but stay in the module)
- `behaviours.js` — all 25 morph behaviours, `leadFor`, `pickMode`
- The render pipeline in `engine.js`: the sprite (hard core, 0.86 feather), additive `lighter` compositing, the SVG alpha-threshold filter (`feGaussianBlur` + `feColorMatrix` alpha × 26 − 13), `dpr = 1`, the 48fps cap, the `document.hidden` skip

## What is removed

- The dormant blob and `idleTick`
- The travelling single mass, `spellOnce`, `cycle`, `restMs`
- The phrase reveal, `phrasePoints`, the collapse-and-return
- The global framing lock (`bbFrom`/`bbTo`/`kx`/`ky`) — with cells pinned to a fixed grid there is no global bounding box to hold still. **Per-cell** containment replaces it: see below.

## Layout

27 cells in two centred rows, bilaterally symmetrical about a shared vertical axis:

| row | cells | content |
|---|---|---|
| 1 | 14 | `T H E ␣ O N L Y ␣ C O N S T` |
| 2 | 13 | `A N T ␣ I S ␣ C H A N G E` |

`CONSTANT` breaks across the row join. This is accepted: the resting state is a scramble in a constructed alphabet nobody reads, and an even block matters more than an intact word at the one moment the phrase resolves.

Both rows are centre-aligned horizontally; the block is centred vertically. Cell advance and row lead are derived so the grid fills the canvas with a uniform gutter — the canvas is a wide banner rather than the v1 square.

Canvas sizing (CSS px), square-free since the form is now wide:

| viewport | canvas |
|---|---|
| ≥ 1024px | 900 × 260 |
| 640–1023px | 620 × 200 |
| < 640px | 340 × 150 |

Filter cost scales with area; 900 × 260 is comparable to v1's 430 × 430, so the budget is unchanged.

## Cell behaviour

Each cell owns its own point field, morph clock, and behaviour choice. Cells are independent — the whole point is that they do not move in unison.

- **Scramble state:** each cell morphs to a new random glyph on its own schedule. Morph ~620ms, hold ~380ms (reusing v1's calibrated timings), each cell's phase offset randomised at mount so they never sync.
- **Random glyph pool:** `A`–`Z` only. Numerals and symbols exist in `CHARMAP` but reading as letters keeps the field coherent.
- **Never the same twice in a row** per cell, via `pickMode`'s sibling logic applied to glyph choice.
- **Behaviour** is drawn per morph per cell from the full 25, never repeating back-to-back within a cell.
- **Space cells** scramble exactly like letter cells while idle. They are what makes the resting block solid.

## Resolve interaction

Trigger is **hover on the ENTER button** (`mouseenter`/`mouseleave`, plus `focus`/`blur` so keyboard users get it too).

- **On resolve:** every cell morphs to its true letter. Space cells fade to nothing over the same duration. A small per-cell stagger (a few tens of ms, ordered left-to-right) reads as a sweep rather than a snap; the total resolve completes in ~700ms.
- **On release:** cells return to scrambling from wherever they are; space cells fade back in.
- Clicking ENTER navigates immediately as it does today. The resolve never delays or intercepts the click.
- Resolve and release must be interruptible — a fast hover-on-hover-off cannot leave a cell stranded or double-scheduled.

## Per-cell containment

v1's framing lock existed because behaviours displace points and the single mass would otherwise swell and drift. That reasoning still applies per cell: a displacing behaviour must not let a cell bleed into its neighbours.

Each cell therefore clamps its own displaced bounding box to its grid allotment, using the same per-axis correction as v1 (`kx`/`ky` derived independently, measured within the same frame, applied from the pre-displacement base positions). Cells are given a modest gutter so ordinary displacement never touches the clamp; the clamp is a backstop for the most aggressive behaviours (`split`, `seam`, `shear`).

## Point budget

The controlling constraint, measured during v1: raising the total to ~16000 points caused a ~3× frame-time cliff (15ms → 63ms, ~65fps → ~16fps) in the current Chrome build. The grid runs continuously rather than for one moment of a cycle, so it must sit well clear of that.

| | desktop | mobile (< 640px) |
|---|---|---|
| points per cell | 240 | 140 |
| total (27 cells) | 6480 | 3780 |

Each cell renders at roughly one-sixth of v1's full-size glyph, so the stroke it must cover is proportionally shorter — 240 points per cell is denser per unit of stroke than v1's 900-point full-size glyph, not sparser. The number is a starting point and must be validated by measuring fusion (median nearest-neighbour spacing versus sprite diameter) and frame time, not by eye.

## Accessibility

- The canvas stays `aria-hidden="true"` and `pointer-events: none`. The Latin tagline below remains the accessible content and does not change.
- `prefers-reduced-motion: reduce` renders one static frame with the phrase **already resolved** — the meaningful state, not a random scramble — and starts no loop.
- The resolve triggers on `focus` as well as hover, so ENTER reveals the phrase for keyboard users.

## Verification

- Fusion: median nearest-neighbour spacing versus sprite diameter, per cell, must be comparable to a correctly-rendering v1 glyph.
- Frame time at rest, measured, with the number recorded. Must hold the 48fps cap comfortably.
- No cell bleeds into a neighbour under any of the 25 behaviours.
- Resolve produces the correct phrase; a fast hover-on-off-on leaves every cell in a valid state.
- Reduced-motion path starts no rAF loop and shows the resolved phrase.
- The grid is bilaterally symmetrical: row centres share a vertical axis.

## Out of scope

- Changing the phrase at runtime (a separate follow-on; the phrase stays a constant for now)
- The v1 IoU shortfall (median 0.855 against a ~0.90 target) — carried forward as a known, invisible-to-the-eye fidelity gap
- Any change to the wordmark, tagline copy, or ENTER button styling
