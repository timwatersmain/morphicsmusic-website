SPRITE LAB — KEPT SET EXPORT
============================
401 sprites: 50 eggs, 100 grubs, 50 cocoons/chrysalises, 201 emergence (includes crossbred specimens).

FILES
  sprites-kept.json   every kept sprite as data
  recipes.js          the 16 animation recipes + the XP functions
  colorways.js        the 12 swappable colourways
  manifest.csv        flat index: ref, id, name, stage, recipe, fps, loop, xp mode

SPRITE FORMAT
  {
    ref:     catalogue number, e.g. "A147"
    id:      kebab-case identifier
    name:    display name
    stage:   "egg" | "grub" | "pupa" | "adult"
    palette: { ".": null, "1": dark, "2": mid, "3": light, "4": accent }
    base:    32 strings of 32 chars, each char a palette key
    recipe:  which animation drives it
    fps:     playback rate
    loop:    "loop" (0-3) or "pingpong" (0-3-2-1)
  }
  Crossbred specimens also carry: code, parents, splice, mutation.

RENDERING A FRAME
  import { frame, sequence } from './recipes.js';
  const grid = frame(sprite, xp, frameIndex);   // xp 0..100
  // grid[row][col] is a palette key; look the colour up in sprite.palette
  // (or in a colourway from colorways.js to recolour it)
  const order = sequence(sprite.loop);          // frame order for the loop

ANIMATION
  Every recipe is a pure function (grid, frameIndex 0..3) -> new grid, and every
  one returns to frame 0's state, so all loops are seamless. Draw at an integer
  scale with nearest-neighbour sampling only (image-rendering: pixelated).

XP
  eggs + cocoons  "crack": the shell fractures progressively across the whole
                  surface, then breaches at the top of the range.
  grubs + adults  "grow": juvenile at XP 0, authored size at XP 80, slightly
                  overgrown by 100 where the grid leaves room.
  applyXp(grid, xp, stage) applies it; frame() already calls it for you.

RULES THE ART FOLLOWS
  32x32 logical pixels, sprite roughly centred with room to move.
  Max 5 colours: a 3-step shade ramp, one accent, plus transparent.
  1px darkest-shade outline on every silhouette, no gaps.
  Accent reserved for eyes, glow points and speckles.
  Single connected silhouette (cocoons may have a detached-looking silk anchor,
  joined by a thread), nothing touching the grid edge.
