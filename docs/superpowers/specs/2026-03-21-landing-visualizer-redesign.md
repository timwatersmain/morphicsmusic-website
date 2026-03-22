# Landing Page Visualizer Redesign

**Date:** 2026-03-21
**Status:** Draft

## Overview

Redesign the Morphics landing page visualizer from a flat-plane chrome fbm shader into a multi-layer audio-reactive scene with a 3D morphing blob, teal fluid tendrils, contour lines, and enhanced waveform. Full cold palette shift from warm peach to teal/blue/purple/grey/black.

## Layer Architecture

The scene composites 7 visual elements across 8 logical layers (L1+L2 share a shader plane), rendered within a single Three.js scene plus HTML overlays.

### Camera Change

The current `OrthographicCamera` must be replaced with a `PerspectiveCamera` to give the 3D blob proper depth and perspective-correct matcap normals. The tendril background plane must be scaled to fill the viewport at its z-depth (calculated from camera FOV and distance).

- **Camera:** `PerspectiveCamera(50, aspect, 0.1, 100)`, positioned at `z = 3`
- **Tendril plane:** Scaled to fill viewport at `z = 0` (width/height computed from FOV + distance)
- **Blob:** Centered at origin `(0, 0, 0)`
- **Particles:** Distributed around origin in 3D (existing gaussian, extended to z-axis)

### Depth & Compositing Strategy

- Tendril plane: `z = 0`, rendered first (opaque, no depth issues)
- Blob: `z = 0`, centered, rendered after tendrils (occludes tendril plane naturally via depth buffer)
- Particles: `depthWrite: false`, `depthTest: true`, `transparent: true` — renders over both blob and tendrils correctly
- `renderOrder` explicitly set: tendril plane = 0, blob = 1, particles = 2

### L0 — Void Background
- Set `renderer.setClearColor(0x0a0a0a)` — the canvas is opaque and covers the viewport, so CSS background has no effect
- No changes to HTML structure

### L1 — Teal Fluid Tendrils + L2 Contour Lines (combined shader plane)
- **Geometry:** `PlaneGeometry` sized to fill viewport at z = 0, behind blob via render order
- **Shader:** Custom fragment shader with:
  - Domain-warped fbm producing directional tendril/vein patterns radiating from center
  - Worley noise or elongated Perlin for fibrous structure
  - Color ramp: black → deep teal (`#0a2626`) → bright teal (`#00ffaa`) → cyan highlights
  - Contour lines via `fract(length(uv) * ringCount)` with thin bright bands, subtle opacity
  - `ringCount` modulated by bass for breathing ring spacing
- **Uniforms:** `uTime`, `uBass`, `uHigh`, `uMid`
- **Audio mapping:**
  - `uBass` → warp intensity + contour ring breathing
  - `uHigh` → phase offset for shimmer/flow speed
  - `uMid` → subtle tendril thickness/brightness modulation
- **Performance:** Same OCTAVES define pattern as existing shader (5 desktop, 3 mobile)

### L3 — Chrome Blob (hero element)
- **Geometry:** `IcosahedronGeometry` with high subdivision (detail level 5 = 20480 faces, detail 4 on mobile = 5120 faces)
- **Material:** Custom `ShaderMaterial` with matcap-style lighting:
  - Load a pre-made chrome/teal matcap texture from `/assets/matcap-chrome.png` (256x256)
  - View-space normal lookup into matcap texture for chrome reflections
  - Teal tint applied in fragment shader
- **Uniforms:** `uTime`, `uBass`, `uMid`, `uMatcap` (sampler2D)
- **Audio-reactive displacement (vertex shader):**
  - 3D simplex noise function (added to shader, ~30 lines of GLSL)
  - Displace vertices along normals: `pos += normal * noise(pos * freq + uTime) * amplitude`
  - `uBass` controls displacement amplitude (0.05 idle → 0.3 at full bass)
  - `uTime` drives noise evolution for continuous morphing
  - `uMid` adds secondary higher-frequency displacement layer for surface detail
- **Visual size:** ~30-35% of viewport width (radius ≈ 0.6 world units, visible size depends on FOV)
- **Render order:** 1 (after tendril plane, before particles)

### L4 — Particle Dust
- **Existing system retained**, with adjustments:
  - Gaussian distribution (SIGMA = 0.35) kept — particles concentrate around blob
  - Particle color updated in **both** places:
    - `createSpriteTexture()` canvas gradient: `rgba(208, 232, 232, 1)` → `rgba(208, 232, 232, 0)`
    - `FRAG_PARTICLE` hardcoded color: `vec4(0.816, 0.91, 0.91, ...)` (= `#D0E8E8`)
  - Audio mapping unchanged: `uMid` drives scatter, spring-damper return to home
  - Count unchanged: 1500 desktop, 400 mobile
  - `depthWrite: false`, `depthTest: true`, `renderOrder: 2`

### L5 — Track Title
- **Element:** `#player-title` (existing)
- **Styling:** `mix-blend-mode: difference` (existing)
- **Font:** Keep Space Grotesk display-lg, no changes
- **Content:** Shows track title from tracks.json (e.g., "001_NULL")

### L6 — Player Controls
- **Structure:** Keep existing glassmorphic pill layout (prev / play / next)
- **Glass effect:** Add scoped style override in `Player.astro` for the player controls tint: `background: rgba(30, 40, 45, 0.6)` — this overrides the global `.glass-prominent` class only within the player component, leaving the global class unchanged for other pages
- **No HTML structural changes** to Player.astro

### L7 — Waveform + Mist
- **Canvas 2D approach (with upgrade path to WebGL):**
  - Increase waveform container height to 80px (50px on mobile) to accommodate mirrored reflection
  - Draw primary waveform in top 60% of canvas height
  - Draw mirrored reflection in bottom 40% at 0.3 opacity
  - Fill between lines with a subtle gradient (transparent teal → transparent)
  - Stroke color: `rgba(0, 204, 168, 0.6)` (teal, matching new primary)
- **Mist effect:** Add CSS `::after` pseudo-element on `.player-waveform-container` **in Player.astro** (scoped styles):
  - Radial gradient from `rgba(10, 38, 38, 0.4)` center to transparent edges
  - `pointer-events: none` to not block interaction
- **Audio mapping:** Waveform data from existing `analyser.getByteTimeDomainData()`

## Color Palette Update

Replace the warm accent system in `global.css`:

```
--primary:              #00CCA8  (teal)
--primary-container:    #007A66  (deep teal)
--on-primary-container: #E0FFF8  (light mint)
--outline-variant:      #2A4A5A  (muted blue-grey)

/* New accent tones */
--accent-blue:          #4488CC
--accent-purple:        #8866BB
--accent-teal-glow:     #00FFAA  (for shader/glow use, not UI)
```

Surface colors stay as-is (already grey/black). The `--error` token stays `#FFB4AB`.

## File Changes

### Modified files:
1. **`src/scripts/visualizer.js`** — Major rewrite:
   - Switch from OrthographicCamera to PerspectiveCamera
   - Replace flat chrome plane with tendril shader plane (sized to fill viewport)
   - Add icosphere blob with custom displacement ShaderMaterial
   - Add 3D simplex noise GLSL function
   - Set explicit renderOrder on all scene objects
   - Configure depth settings for particles
   - Update particle color in both sprite texture and fragment shader
   - Set renderer clear color to `#0a0a0a`
   - Update header comment to reference this spec
   - Post-processing: bloom stays white (UnrealBloomPass has no tint), chromatic aberration unchanged

2. **`src/styles/global.css`** — Update color tokens (primary, primary-container, on-primary-container, outline-variant). Add new accent variables (accent-blue, accent-purple, accent-teal-glow).

3. **`src/components/Player.astro`** — Scoped style changes only (no HTML changes):
   - Override `.player-controls` background to `rgba(30, 40, 45, 0.6)`
   - Increase `.player-waveform-container` height to 80px (50px mobile)
   - Add `::after` pseudo-element on waveform container for mist effect

4. **`src/scripts/player.js`** — Update `drawWaveform()` function:
   - Dual-line mirrored waveform (primary + reflection at 0.3 opacity)
   - Gradient fill between lines
   - Update stroke color to teal `rgba(0, 204, 168, 0.6)`

### New files:
- **`public/assets/matcap-chrome.png`** — 256x256 chrome/teal matcap texture (needs to be created or sourced)

### Unchanged:
- `Nav.astro` — keep current structure
- `index.astro` — no changes needed (mist lives in Player.astro scoped styles)
- `astro.config.mjs` — no build changes
- Page routes — no changes

### Update needed:
- **`public/assets/chrome-blob-landing.png`** — WebGL fallback image should be updated to reflect new teal aesthetic (can be done post-implementation with a screenshot)

## Audio Reactivity Summary

| Band | Frequency Range | Drives |
|------|----------------|--------|
| Bass (0-9 bins) | Sub + kick | Blob displacement amplitude, tendril warp intensity, contour ring breathing |
| Mid (10-92 bins) | Vocals + synths | Particle scatter, blob secondary detail, tendril brightness |
| High (93-929 bins) | Hats + air | Tendril shimmer/phase, chromatic aberration strength |

## Performance Considerations

- Icosphere detail: 5 on desktop (20K faces), 4 on mobile (5K faces)
- Tendril shader OCTAVES: 5 desktop, 3 mobile (same as current)
- Single EffectComposer pipeline: RenderPass → UnrealBloomPass → ChromaticAberration (desktop only)
- Matcap avoids expensive environment map sampling
- 3D simplex noise in vertex shader is lightweight (~30 lines GLSL, runs per-vertex not per-pixel)
- Fallback: if WebGL fails, show static image (existing fallback mechanism)

## Upgrade Path

- L7 waveform: if Canvas 2D doesn't achieve desired mist effect, migrate to a WebGL plane rendered in the Three.js scene with a dedicated waveform shader
