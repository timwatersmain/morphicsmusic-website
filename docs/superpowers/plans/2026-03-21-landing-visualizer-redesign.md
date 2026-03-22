# Landing Page Visualizer Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Morphics landing page from a flat chrome fbm shader into a multi-layer audio-reactive 3D scene with morphing blob, teal tendrils, and particle dust.

**Architecture:** Single Three.js scene with PerspectiveCamera compositing: tendril shader plane (background) → 3D icosphere blob with matcap + vertex displacement → particle dust system. All layers audio-reactive via Web Audio API frequency bands. HTML overlay for title + player controls.

**Tech Stack:** Astro, Three.js (postprocessing: EffectComposer, UnrealBloomPass, ShaderPass), Web Audio API, GLSL shaders

**Spec:** `docs/superpowers/specs/2026-03-21-landing-visualizer-redesign.md`

---

### Task 1: Update Color Palette

**Files:**
- Modify: `src/styles/global.css:18-21` (color tokens)
- Modify: `src/styles/global.css:182-184` (ghost-border color)

- [ ] **Step 1: Update primary color tokens in global.css**

Replace the warm accent tokens in `:root`:

```css
  --primary: #00CCA8;
  --primary-container: #007A66;
  --on-primary-container: #E0FFF8;
  --outline-variant: #2A4A5A;
```

- [ ] **Step 2: Add new accent variables after `--error`**

```css
  --accent-blue: #4488CC;
  --accent-purple: #8866BB;
  --accent-teal-glow: #00FFAA;
```

- [ ] **Step 3: Update ghost-border color to match new palette**

```css
.ghost-border {
  border: 1px solid rgba(42, 74, 90, 0.15);
}
```

- [ ] **Step 4: Update btn-secondary border to match**

```css
  border: 1px solid rgba(42, 74, 90, 0.15);
```

- [ ] **Step 5: Verify — run dev server and check other pages**

Run: `npm run dev`
Check: `/music`, `/about`, `/contact` pages still look correct with new teal accents.

- [ ] **Step 6: Commit**

```bash
git add src/styles/global.css
git commit -m "style: update color palette from warm peach to teal/blue/purple"
```

---

### Task 2: Generate Matcap Texture

**Files:**
- Create: `src/scripts/matcap.js` (procedural matcap generator utility)
The blob needs a chrome/teal matcap texture for reflective look. We generate it programmatically at runtime via canvas (no static PNG file needed — deviates from spec which listed a PNG asset).

- [ ] **Step 1: Create matcap generator script**

Create `src/scripts/matcap.js`:

```js
/**
 * Generates a chrome/teal matcap texture as a canvas.
 * Browser-only (uses canvas API). Called at runtime by visualizer.js
 * to create a Three.js CanvasTexture.
 */

export function createMatcapCanvas(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;

  // Base sphere gradient (dark edges, bright center-top-left)
  const base = ctx.createRadialGradient(
    half * 0.7, half * 0.6, 0,
    half, half, half
  );
  base.addColorStop(0, '#e8f0f0');   // bright highlight
  base.addColorStop(0.3, '#8aa0a8'); // chrome mid
  base.addColorStop(0.6, '#3a5a5a'); // teal-chrome
  base.addColorStop(0.85, '#1a2828'); // dark edge
  base.addColorStop(1, '#0a1414');    // void edge

  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // Teal reflection band (lower-right)
  const teal = ctx.createRadialGradient(
    half * 1.3, half * 1.2, 0,
    half * 1.3, half * 1.2, half * 0.6
  );
  teal.addColorStop(0, 'rgba(0, 204, 168, 0.4)');
  teal.addColorStop(0.5, 'rgba(0, 204, 168, 0.15)');
  teal.addColorStop(1, 'rgba(0, 204, 168, 0)');
  ctx.fillStyle = teal;
  ctx.fillRect(0, 0, size, size);

  // Specular highlight (top-left)
  const spec = ctx.createRadialGradient(
    half * 0.55, half * 0.45, 0,
    half * 0.55, half * 0.45, half * 0.3
  );
  spec.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
  spec.addColorStop(0.4, 'rgba(220, 240, 240, 0.3)');
  spec.addColorStop(1, 'rgba(220, 240, 240, 0)');
  ctx.fillStyle = spec;
  ctx.fillRect(0, 0, size, size);

  // Purple ambient (left edge)
  const purple = ctx.createRadialGradient(
    half * 0.2, half * 1.0, 0,
    half * 0.2, half * 1.0, half * 0.5
  );
  purple.addColorStop(0, 'rgba(136, 102, 187, 0.25)');
  purple.addColorStop(1, 'rgba(136, 102, 187, 0)');
  ctx.fillStyle = purple;
  ctx.fillRect(0, 0, size, size);

  // Clip to circle
  ctx.globalCompositeOperation = 'destination-in';
  ctx.beginPath();
  ctx.arc(half, half, half, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  return canvas;
}
```

This will be called at runtime in the visualizer to create a `CanvasTexture` — no need for a static PNG file.

- [ ] **Step 2: Commit**

```bash
git add src/scripts/matcap.js
git commit -m "feat: add procedural chrome/teal matcap texture generator"
```

---

### Task 3: Rewrite Visualizer — Scene Setup

**Files:**
- Modify: `src/scripts/visualizer.js:1-11` (imports)
- Modify: `src/scripts/visualizer.js:180-199` (renderer, scene, camera)

This task replaces the camera and renderer setup. The existing chrome plane and particle code is preserved as-is (it will look wrong with the new camera but won't error). Tasks 4-6 replace each layer properly.

**Important:** Do NOT modify the `onResize` function in this task — that happens in Task 4 when the tendril plane is added. The existing `onResize` still works with the composer.

- [ ] **Step 1: Update file header comment**

```js
/** Morphics Landing Page Visualizer
 *  Three.js WebGL audio-reactive: tendril plane + 3D blob + particle field
 *  Spec: docs/superpowers/specs/2026-03-21-landing-visualizer-redesign.md
 */
```

- [ ] **Step 2: Replace camera setup**

Replace the OrthographicCamera block (lines 196-198) with:

```js
  // --- Scene + camera ---
  const scene = new THREE.Scene();
  const aspect = canvas.clientWidth / canvas.clientHeight;
  const camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 100);
  camera.position.z = 3;
```

- [ ] **Step 3: Add renderer clear color**

After `renderer.setSize(...)`, add:

```js
  renderer.setClearColor(0x0a0a0a);
```

- [ ] **Step 4: Add viewport-fill plane size helper**

Add to helpers section:

```js
/** Calculate plane dimensions to fill viewport at a given z-depth */
function getViewportPlaneSize(camera, z) {
  const dist = camera.position.z - z;
  const vFov = (camera.fov * Math.PI) / 180;
  const h = 2 * Math.tan(vFov / 2) * dist;
  const w = h * camera.aspect;
  return { w, h };
}
```

- [ ] **Step 5: Verify — page loads without errors**

Run: `npm run dev`, open `http://localhost:4321`
Expected: Existing chrome shader visible (will look distorted with PerspectiveCamera — that's fine, it gets replaced in Task 4). No console errors.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/visualizer.js
git commit -m "refactor(visualizer): switch to PerspectiveCamera, add viewport helper"
```

---

### Task 4: Tendril Shader Plane (L1 + L2)

**Files:**
- Modify: `src/scripts/visualizer.js` — replace VERT_CHROME/FRAG_CHROME shaders and chrome plane mesh

- [ ] **Step 1: Replace chrome shaders with tendril shaders**

Replace `VERT_CHROME` and `FRAG_CHROME` with:

```js
const VERT_TENDRIL = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG_TENDRIL = /* glsl */`
precision highp float;
uniform float uTime;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
varying vec2 vUv;

vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(dot(hash22(i), f), dot(hash22(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
    mix(dot(hash22(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
        dot(hash22(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < OCTAVES; i++) {
    value += amplitude * noise(p);
    p = m * p;
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = (vUv - 0.5) * 2.0;
  float t = uTime * 0.08 + uHigh * 2.5;

  // Directional bias: stretch noise along radial lines from center
  float angle = atan(uv.y, uv.x);
  float radius = length(uv);
  vec2 polarUv = vec2(angle * 0.5, radius * 1.5);

  // Two-level domain warp for organic tendril shapes
  float warpStrength = 0.8 + uBass * 0.6;
  vec2 q = vec2(fbm(polarUv + vec2(0.0, t)), fbm(polarUv + vec2(5.2, t * 0.7)));
  vec2 r = vec2(
    fbm(polarUv + q * warpStrength + vec2(1.7, 9.2) + 0.15 * t),
    fbm(polarUv + q * warpStrength + vec2(8.3, 2.8) + 0.126 * t)
  );

  float f = fbm(polarUv + r * warpStrength);
  float n = clamp(f * 0.5 + 0.5, 0.0, 1.0);

  // Tendril mask: fade toward center (blob occludes) and edges
  float tendrilMask = smoothstep(0.05, 0.3, radius) * smoothstep(1.4, 0.5, radius);
  n *= tendrilMask;

  // Mid modulates brightness
  float brightness = 0.8 + uMid * 0.4;

  // Color ramp: void -> deep teal -> bright teal -> cyan highlights
  vec3 voidCol = vec3(0.04, 0.04, 0.04);
  vec3 deepTeal = vec3(0.04, 0.15, 0.15);
  vec3 brightTeal = vec3(0.0, 1.0, 0.667);  // #00FFAA
  vec3 cyan = vec3(0.0, 0.85, 0.85);

  vec3 col = mix(voidCol, deepTeal, smoothstep(0.15, 0.4, n));
  col = mix(col, brightTeal * 0.4, smoothstep(0.4, 0.7, n));
  col = mix(col, cyan * 0.5, smoothstep(0.7, 0.95, n));
  col *= brightness;

  // L2: Contour lines — concentric rings from center
  float ringCount = 8.0 + uBass * 4.0;
  float rings = fract(radius * ringCount);
  float ringLine = smoothstep(0.0, 0.04, rings) * smoothstep(0.08, 0.04, rings);
  float ringAlpha = 0.06 + uBass * 0.08;
  col += vec3(0.0, 0.8, 0.66) * ringLine * ringAlpha * smoothstep(1.2, 0.2, radius);

  gl_FragColor = vec4(col, 1.0);
}`;
```

- [ ] **Step 2: Replace chrome plane mesh with tendril plane**

Replace the chrome plane creation block with:

```js
  // --- Tendril background plane (L1 + L2) ---
  const tendrilUniforms = {
    uTime: { value: 0 },
    uBass: { value: AMBIENT.bass },
    uMid:  { value: AMBIENT.mid },
    uHigh: { value: AMBIENT.high },
  };
  const { w: planeW, h: planeH } = getViewportPlaneSize(camera, 0);
  const tendrilMat = new THREE.ShaderMaterial({
    uniforms:       tendrilUniforms,
    vertexShader:   VERT_TENDRIL,
    fragmentShader: FRAG_TENDRIL,
    defines:        { OCTAVES: isMobile ? 3 : 5 },
  });
  const tendrilMesh = new THREE.Mesh(new THREE.PlaneGeometry(planeW, planeH), tendrilMat);
  tendrilMesh.position.z = -0.5; // Behind blob to avoid z-fighting
  tendrilMesh.renderOrder = 0;
  scene.add(tendrilMesh);
```

- [ ] **Step 3: Update animate loop to feed tendril uniforms**

Replace `chromeUniforms` references with `tendrilUniforms`:

```js
    tendrilUniforms.uTime.value = performance.now() / 1000;
    tendrilUniforms.uBass.value = bass;
    tendrilUniforms.uMid.value  = mid;
    tendrilUniforms.uHigh.value = high;
```

- [ ] **Step 4: Replace onResize to handle PerspectiveCamera + tendril plane**

Replace the entire `onResize` function:

```js
  function onResize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    // Re-scale tendril plane to fill viewport at its z-depth
    const { w: pw, h: ph } = getViewportPlaneSize(camera, tendrilMesh.position.z);
    tendrilMesh.geometry.dispose();
    tendrilMesh.geometry = new THREE.PlaneGeometry(pw, ph);
  }
```

- [ ] **Step 5: Verify — tendrils visible on landing page**

Run: `npm run dev`, open `http://localhost:4321`
Expected: Teal tendril patterns visible, slowly moving, with subtle contour rings. No blob yet.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/visualizer.js
git commit -m "feat(visualizer): add teal tendril shader plane with contour lines (L1+L2)"
```

---

### Task 5: Chrome Blob (L3)

**Files:**
- Modify: `src/scripts/visualizer.js` — add blob shaders, geometry, matcap material
- Reference: `src/scripts/matcap.js` (import createMatcapCanvas)

- [ ] **Step 1: Add 3D simplex noise GLSL**

Add after the tendril shaders:

```js
// 3D simplex noise for vertex displacement (Stefan Gustavson)
const SIMPLEX_3D = /* glsl */`
vec4 permute(vec4 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
  + i.y + vec4(0.0, i1.y, i2.y, 1.0))
  + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0/7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;
```

- [ ] **Step 2: Add blob vertex and fragment shaders**

```js
const VERT_BLOB = /* glsl */`
${SIMPLEX_3D}
uniform float uTime;
uniform float uBass;
uniform float uMid;
varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
  // Low-frequency displacement (bass-driven, organic bulges)
  float lowFreq = snoise(position * 1.5 + uTime * 0.3) * (0.05 + uBass * 0.25);
  // High-frequency detail (mid-driven, surface ripples)
  float hiFreq = snoise(position * 4.0 + uTime * 0.6) * uMid * 0.08;

  vec3 displaced = position + normal * (lowFreq + hiFreq);

  vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
  vViewPosition = -mvPosition.xyz;

  // Recompute normal approximation (finite difference would be better but costly)
  vNormal = normalMatrix * normal;

  gl_Position = projectionMatrix * mvPosition;
}`;

const FRAG_BLOB = /* glsl */`
precision highp float;
uniform sampler2D uMatcap;
uniform float uBass;
varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
  // Matcap UV from view-space normal
  vec3 n = normalize(vNormal);
  vec3 viewDir = normalize(vViewPosition);
  vec3 x = normalize(vec3(viewDir.z, 0.0, -viewDir.x));
  vec3 y = cross(viewDir, x);
  vec2 matcapUv = vec2(dot(x, n), dot(y, n)) * 0.495 + 0.5;

  vec4 matcapColor = texture2D(uMatcap, matcapUv);

  // Subtle teal tint that increases with bass
  vec3 tealTint = vec3(0.0, 0.8, 0.66);
  vec3 col = mix(matcapColor.rgb, matcapColor.rgb + tealTint * 0.15, uBass);

  gl_FragColor = vec4(col, 1.0);
}`;
```

- [ ] **Step 3: Add matcap import at file top-level**

Add to the imports section at the top of `visualizer.js` (after the Three.js imports):

```js
import { createMatcapCanvas } from './matcap.js';
```

- [ ] **Step 4: Add blob mesh to scene**

Add after tendril plane creation inside `initVisualizer()`:

```js
  // --- Chrome blob (L3) ---
  const matcapTexture = new THREE.CanvasTexture(createMatcapCanvas(256));
  const blobUniforms = {
    uTime:   { value: 0 },
    uBass:   { value: AMBIENT.bass },
    uMid:    { value: AMBIENT.mid },
    uMatcap: { value: matcapTexture },
  };
  const blobDetail = isMobile ? 4 : 5;
  const blobGeo = new THREE.IcosahedronGeometry(0.6, blobDetail);
  const blobMat = new THREE.ShaderMaterial({
    uniforms:       blobUniforms,
    vertexShader:   VERT_BLOB,
    fragmentShader: FRAG_BLOB,
  });
  const blobMesh = new THREE.Mesh(blobGeo, blobMat);
  blobMesh.renderOrder = 1;
  scene.add(blobMesh);
```

- [ ] **Step 5: Feed blob uniforms in animate loop**

Add after tendril uniform updates:

```js
    blobUniforms.uTime.value = performance.now() / 1000;
    blobUniforms.uBass.value = bass;
    blobUniforms.uMid.value  = mid;
```

- [ ] **Step 6: Verify — blob visible and morphing**

Run: `npm run dev`, open `http://localhost:4321`
Expected: Chrome/teal sphere in center, slowly morphing. Press play — blob should pulse with bass. Tendrils visible behind it.

- [ ] **Step 7: Commit**

```bash
git add src/scripts/visualizer.js
git commit -m "feat(visualizer): add 3D icosphere blob with audio-reactive displacement (L3)"
```

---

### Task 6: Update Particles (L4)

**Files:**
- Modify: `src/scripts/visualizer.js` — particle color + depth settings

- [ ] **Step 1: Update sprite texture color**

In `createSpriteTexture()`, change gradient colors:

```js
  g.addColorStop(0, 'rgba(208,232,232,1)');
  g.addColorStop(1, 'rgba(208,232,232,0)');
```

- [ ] **Step 2: Update particle fragment shader color**

In `FRAG_PARTICLE`, change the hardcoded color:

```glsl
  gl_FragColor = vec4(0.816, 0.91, 0.91, tex.a * vOpacity);
```

- [ ] **Step 3: Extend particle distribution to z-axis**

In the particle initialization loop, replace `homePos[i*3+2] = positions[i*3+2] = 0;` with:

```js
    const [x, y] = gaussian(SIGMA);
    const [, z] = gaussian(SIGMA * 0.3); // shallow z-spread for depth
    homePos[i*3]   = positions[i*3]   = x;
    homePos[i*3+1] = positions[i*3+1] = y;
    homePos[i*3+2] = positions[i*3+2] = z;
```

This gives particles subtle depth variation with the PerspectiveCamera.

- [ ] **Step 4: Set particle depth and render order**

Update particle material creation:

```js
  const particleMat = new THREE.ShaderMaterial({
    uniforms:       { uSprite: { value: createSpriteTexture() } },
    vertexShader:   VERT_PARTICLE,
    fragmentShader: FRAG_PARTICLE,
    transparent:    true,
    depthWrite:     false,
    depthTest:      true,
  });
  const particlePoints = new THREE.Points(particleGeo, particleMat);
  particlePoints.renderOrder = 2;
  scene.add(particlePoints);
```

- [ ] **Step 5: Verify — particles teal-tinted, render over blob**

Run: `npm run dev`
Expected: Particles now have subtle teal tint, render correctly over blob and tendrils.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/visualizer.js
git commit -m "style(visualizer): update particle color to teal, add z-depth, fix render order (L4)"
```

---

### Task 7: Update Player Styles (L6)

**Files:**
- Modify: `src/components/Player.astro:64-70` (scoped style override for glass tint)
- Modify: `src/components/Player.astro:91-95` (waveform container height)

- [ ] **Step 1: Add scoped glass tint override**

In Player.astro `<style>` block, update `.player-controls`:

```css
  .player-controls {
    display: flex;
    align-items: center;
    gap: var(--space-6);
    padding: var(--space-3) var(--space-6);
    border-radius: var(--radius-full);
    background: rgba(30, 40, 45, 0.6);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
  }
```

This overrides the `.glass-prominent` class for the player only.

- [ ] **Step 2: Update waveform container height**

```css
  .player-waveform-container {
    width: 100%;
    max-width: 600px;
    height: 80px;
    position: relative;
  }
```

- [ ] **Step 3: Add mist pseudo-element**

Add after `.player-waveform-container canvas` rule:

```css
  .player-waveform-container::after {
    content: '';
    position: absolute;
    inset: -20px -40px;
    background: radial-gradient(ellipse, rgba(10, 38, 38, 0.4), transparent 70%);
    pointer-events: none;
    z-index: -1;
  }
```

- [ ] **Step 4: Update mobile waveform height**

In the `@media (max-width: 480px)` block:

```css
    .player-waveform-container {
      max-width: 90vw;
      height: 50px;
    }
```

- [ ] **Step 5: Verify — player controls have cool-toned glass, mist visible**

Run: `npm run dev`
Expected: Player controls bar has a cooler/darker tint. Subtle mist glow behind waveform area.

- [ ] **Step 6: Commit**

```bash
git add src/components/Player.astro
git commit -m "style(player): update glass tint to cool palette, add waveform mist"
```

---

### Task 8: Update Waveform Drawing (L7)

**Files:**
- Modify: `src/scripts/player.js:108-150` (drawWaveform function)

- [ ] **Step 1: Replace drawWaveform with dual-line mirrored version**

```js
function drawWaveform() {
  if (!analyser || !canvas || !ctx) return;
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    animationId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(dataArray);

    const width = canvas.width;
    const height = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    const cssHeight = height / dpr;

    ctx.clearRect(0, 0, width, height);

    const primaryY = cssHeight * 0.4;   // primary line at 40% height
    const reflectY = cssHeight * 0.6;   // reflection at 60% height
    const amplitude = cssHeight * 0.25; // waveform amplitude

    const sliceWidth = (width / dpr) / bufferLength;

    // --- Primary waveform ---
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0, 204, 168, 0.6)';
    ctx.beginPath();
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = (dataArray[i] / 128.0) - 1.0;
      const y = primaryY + v * amplitude;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.stroke();

    // --- Mirrored reflection ---
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0, 204, 168, 0.3)';
    ctx.beginPath();
    x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = (dataArray[i] / 128.0) - 1.0;
      const y = reflectY - v * amplitude * 0.6;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.stroke();

    // --- Gradient fill between lines ---
    const grad = ctx.createLinearGradient(0, primaryY, 0, reflectY);
    grad.addColorStop(0, 'rgba(0, 204, 168, 0.08)');
    grad.addColorStop(0.5, 'rgba(0, 204, 168, 0.03)');
    grad.addColorStop(1, 'rgba(0, 204, 168, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, primaryY, width / dpr, reflectY - primaryY);
  }

  draw();
}
```

- [ ] **Step 2: Verify — waveform renders with teal dual-line and mist**

Run: `npm run dev`, press play
Expected: Teal waveform with mirrored reflection below, gradient fill between, misty glow behind.

- [ ] **Step 3: Commit**

```bash
git add src/scripts/player.js
git commit -m "feat(player): dual-line mirrored waveform with teal color"
```

---

### Task 9: Audio Reactivity Tuning

**Files:**
- Modify: `src/scripts/visualizer.js` — EMA constants, attack/release

This task fine-tunes how snappy vs smooth the audio response feels.

- [ ] **Step 1: Add asymmetric EMA (fast attack, slow release)**

Replace the simple EMA block in the animate loop with:

```js
    if (analyser) {
      const raw = readBands(analyser);
      // Asymmetric EMA: fast attack (0.3), slow release (0.08) for musical feel
      const attackAlpha = 0.3;
      const releaseAlpha = 0.08;
      for (const band of ['bass', 'mid', 'high']) {
        const alpha = raw[band] > ema[band] ? attackAlpha : releaseAlpha;
        ema[band] = ema[band] * (1 - alpha) + raw[band] * alpha;
      }
      bass = ema.bass; mid = ema.mid; high = ema.high;
    }
```

- [ ] **Step 2: Remove old EMA_ALPHA constant**

Delete: `const EMA_ALPHA = 0.15;`

- [ ] **Step 3: Verify — audio response feels punchy on hits, smooth on decay**

Run: `npm run dev`, play MYSTERIUM
Expected: Bass hits land fast, blob snaps to size. Release is smooth and organic.

- [ ] **Step 4: Commit**

```bash
git add src/scripts/visualizer.js
git commit -m "feat(visualizer): asymmetric EMA for punchy attack, smooth release"
```

---

### Task 10: Final Integration & Cleanup

**Files:**
- Modify: `src/scripts/visualizer.js` — remove any dead code from old chrome shader
- Verify: all pages

- [ ] **Step 1: Remove dead code**

Ensure no references to old `chromeUniforms`, `VERT_CHROME`, `FRAG_CHROME`, or old color constants remain.

- [ ] **Step 2: Remove old `FRAG_CHROME` warm primary color**

Verify no `vec3(1.0, 0.706, 0.639)` (#FFB4A3) references remain in any shader.

- [ ] **Step 3: Full visual check — landing page**

Run: `npm run dev`, open `http://localhost:4321`

Checklist:
- [ ] Teal tendrils visible and flowing
- [ ] Contour rings breathing subtly
- [ ] Chrome blob centered, morphing organically
- [ ] Particles floating around blob with teal tint
- [ ] Track title visible with blend-mode difference
- [ ] Player controls have cool glass tint
- [ ] Press play: all layers respond to audio
- [ ] Bass → blob pulses, tendrils intensify, contour rings breathe
- [ ] Mid → particles scatter outward
- [ ] High → tendril shimmer, chromatic aberration shifts
- [ ] No console errors

- [ ] **Step 4: Check other pages**

Verify `/music`, `/about`, `/contact` render correctly with new teal palette.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete landing page visualizer redesign — teal palette, 3D blob, tendrils"
```
