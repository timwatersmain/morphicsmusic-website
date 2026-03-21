/** Morphics Landing Page Visualizer
 *  Three.js WebGL audio-reactive: tendril plane + 3D blob + particle field
 *  Spec: docs/superpowers/specs/2026-03-21-landing-visualizer-redesign.md
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// ---------------------------------------------------------------------------
// Shader source
// ---------------------------------------------------------------------------

const VERT_CHROME = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// OCTAVES is injected via ShaderMaterial.defines (5 desktop, 3 mobile)
const FRAG_CHROME = /* glsl */`
precision highp float;
uniform float uTime;
uniform float uBass;
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
    mix(dot(hash22(i + vec2(0.0,0.0)), f - vec2(0.0,0.0)),
        dot(hash22(i + vec2(1.0,0.0)), f - vec2(1.0,0.0)), u.x),
    mix(dot(hash22(i + vec2(0.0,1.0)), f - vec2(0.0,1.0)),
        dot(hash22(i + vec2(1.0,1.0)), f - vec2(1.0,1.0)), u.x),
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
  // Base speed 0.12 units/sec; uHigh adds phase offset (shimmer = phase jumps, not speed)
  float t = uTime * 0.12 + uHigh * 2.0;

  // Two-level domain warp: q warps into r, r warps into final sample
  vec2 q = vec2(fbm(uv + vec2(0.0, t)),
                fbm(uv + vec2(5.2, t * 0.8)));
  vec2 r = vec2(fbm(uv + q + vec2(1.7, 9.2) + 0.15 * t),
                fbm(uv + q + vec2(8.3, 2.8) + 0.126 * t));

  // Bass pushes the warp domain outward
  r += uBass * 0.3;

  float f = fbm(uv + r);
  float n = clamp(f * 0.5 + 0.5, 0.0, 1.0);

  // Chrome color ramp: void -> chrome -> specular white; bass bleeds primary
  vec3 voidCol    = vec3(0.075, 0.075, 0.075); // #131313
  vec3 chromeCol  = vec3(0.78,  0.78,  0.78);  // #C8C8C8
  vec3 specular   = vec3(1.0,   1.0,   1.0);
  vec3 primary    = vec3(1.0,   0.706, 0.639); // #FFB4A3

  vec3 col = mix(voidCol,   chromeCol, smoothstep(0.2, 0.6,  n));
  col      = mix(col,       specular,  smoothstep(0.65, 0.9, n));
  col      = mix(col,       primary,   uBass * smoothstep(0.7, 1.0, n));
  col     *= 0.75 + uBass * 0.25;

  gl_FragColor = vec4(col, 1.0);
}`;

const VERT_PARTICLE = /* glsl */`
attribute float size;
attribute float opacity;
varying float vOpacity;
void main() {
  vOpacity = opacity;
  gl_PointSize = size;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG_PARTICLE = /* glsl */`
precision mediump float;
uniform sampler2D uSprite;
varying float vOpacity;
void main() {
  vec4 tex = texture2D(uSprite, gl_PointCoord);
  gl_FragColor = vec4(0.78, 0.78, 0.78, tex.a * vOpacity);
}`;

const CHROMATIC_SHADER = {
  uniforms: {
    tDiffuse:  { value: null },
    uStrength: { value: 0.003 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    precision mediump float;
    uniform sampler2D tDiffuse;
    uniform float uStrength;
    varying vec2 vUv;
    void main() {
      vec2 offset = vec2(uStrength, 0.0);
      float r = texture2D(tDiffuse, vUv - offset).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv + offset).b;
      gl_FragColor = vec4(r, g, b, 1.0);
    }`,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AMBIENT    = { bass: 0.08, mid: 0.05, high: 0.08 };
const EMA_ALPHA  = 0.15;
const SPRING_K   = 0.03;
const DAMPING    = 0.85;
const JITTER     = 0.0008;  // micro-jitter per frame per axis
// Note: spec's scatter value of 2.5 assumes larger world-space units.
// In NDC (-1..1) space, 0.008 gives visible scatter (~0.05 unit equilibrium offset at uMid=1).
const SCATTER    = 0.008;   // world-units/frame scatter impulse at uMid=1
const SIGMA      = 0.35;    // gaussian sigma in world units (-1..1 space)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSpriteTexture() {
  const size = 32;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  g.addColorStop(0, 'rgba(220,220,220,1)');
  g.addColorStop(1, 'rgba(220,220,220,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

function gaussian(sigma) {
  // Box-Muller transform
  const u1 = Math.random() || 1e-10;
  const u2 = Math.random();
  const r   = sigma * Math.sqrt(-2 * Math.log(u1));
  const th  = 2 * Math.PI * u2;
  return [r * Math.cos(th), r * Math.sin(th)];
}

/** Calculate plane dimensions to fill viewport at a given z-depth */
function getViewportPlaneSize(camera, z) {
  const dist = camera.position.z - z;
  const vFov = (camera.fov * Math.PI) / 180;
  const h = 2 * Math.tan(vFov / 2) * dist;
  const w = h * camera.aspect;
  return { w, h };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function initVisualizer(canvas, getAnalyserFn) {
  const isMobile = window.innerWidth < 768;

  // --- Renderer ---
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
  } catch (e) {
    canvas.dispatchEvent(new CustomEvent('visualizer:failed'));
    return;
  }
  const maxDpr = isMobile ? 1 : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxDpr));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.setClearColor(0x0a0a0a);

  // --- Scene + camera ---
  const scene = new THREE.Scene();
  const aspect = canvas.clientWidth / canvas.clientHeight;
  const camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 100);
  camera.position.z = 3;

  // --- Chrome fluid surface ---
  const chromeUniforms = {
    uTime: { value: 0 },
    uBass: { value: AMBIENT.bass },
    uHigh: { value: AMBIENT.high },
  };
  const chromeMat = new THREE.ShaderMaterial({
    uniforms:       chromeUniforms,
    vertexShader:   VERT_CHROME,
    fragmentShader: FRAG_CHROME,
    defines:        { OCTAVES: isMobile ? 3 : 5 },
  });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), chromeMat));

  // --- Particles ---
  const particleCount = isMobile ? 400 : 1500;
  const positions     = new Float32Array(particleCount * 3);
  const homePos       = new Float32Array(particleCount * 3);
  const velocities    = new Float32Array(particleCount * 3); // zero-initialized
  const sizes         = new Float32Array(particleCount);
  const opacities     = new Float32Array(particleCount);

  for (let i = 0; i < particleCount; i++) {
    const [x, y] = gaussian(SIGMA);
    homePos[i*3]   = positions[i*3]   = x;
    homePos[i*3+1] = positions[i*3+1] = y;
    homePos[i*3+2] = positions[i*3+2] = 0;
    sizes[i]    = Math.random() * 2 + 1;      // 1–3 px
    opacities[i] = Math.random() * 0.5 + 0.4; // 0.4–0.9
  }

  const particleGeo = new THREE.BufferGeometry();
  particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  particleGeo.setAttribute('size',     new THREE.BufferAttribute(sizes, 1));
  particleGeo.setAttribute('opacity',  new THREE.BufferAttribute(opacities, 1));

  const particleMat = new THREE.ShaderMaterial({
    uniforms:       { uSprite: { value: createSpriteTexture() } },
    vertexShader:   VERT_PARTICLE,
    fragmentShader: FRAG_PARTICLE,
    transparent:    true,
    depthWrite:     false,
  });
  scene.add(new THREE.Points(particleGeo, particleMat));

  // --- Post-processing ---
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloomStrength = isMobile ? 0.5 : 0.8;
  composer.addPass(new UnrealBloomPass(
    new THREE.Vector2(canvas.clientWidth, canvas.clientHeight),
    bloomStrength, 0.6, 0.2
  ));

  let chromaPass = null;
  if (!isMobile) {
    chromaPass = new ShaderPass(CHROMATIC_SHADER);
    composer.addPass(chromaPass);
  }

  // --- Audio state ---
  const ema   = { bass: AMBIENT.bass, mid: AMBIENT.mid, high: AMBIENT.high };
  let freqData = null;

  function readBands(analyser) {
    if (!freqData) freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freqData);
    let bass = 0, mid = 0, high = 0;
    for (let i = 0;  i < 10;  i++) bass += freqData[i];   // bins 0-9
    for (let i = 10; i < 93;  i++) mid  += freqData[i];   // bins 10-92
    for (let i = 93; i < 930; i++) high += freqData[i];   // bins 93-929
    return {
      bass: bass / (10  * 255),
      mid:  mid  / (83  * 255),
      high: high / (837 * 255),
    };
  }

  // --- Particle update ---
  function updateParticles(uMid) {
    const pos = particleGeo.attributes.position.array;
    for (let i = 0; i < particleCount; i++) {
      const i3 = i * 3;
      const px = pos[i3], py = pos[i3+1];

      // Spring toward home
      velocities[i3]   += (homePos[i3]   - px) * SPRING_K;
      velocities[i3+1] += (homePos[i3+1] - py) * SPRING_K;

      // Outward scatter impulse from centre
      const dist = Math.sqrt(px*px + py*py) || 1;
      velocities[i3]   += (px / dist) * uMid * SCATTER;
      velocities[i3+1] += (py / dist) * uMid * SCATTER;

      // Micro-jitter
      velocities[i3]   += (Math.random() - 0.5) * JITTER;
      velocities[i3+1] += (Math.random() - 0.5) * JITTER;

      // Damping + integrate
      velocities[i3]   *= DAMPING;
      velocities[i3+1] *= DAMPING;
      pos[i3]   += velocities[i3];
      pos[i3+1] += velocities[i3+1];
    }
    particleGeo.attributes.position.needsUpdate = true;
  }

  // --- Resize ---
  function onResize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
  }
  window.addEventListener('resize', onResize);

  // --- Render loop ---
  function animate() {
    requestAnimationFrame(animate);

    const analyser = getAnalyserFn();
    let bass = AMBIENT.bass, mid = AMBIENT.mid, high = AMBIENT.high;

    if (analyser) {
      const raw = readBands(analyser);
      ema.bass = ema.bass * (1 - EMA_ALPHA) + raw.bass * EMA_ALPHA;
      ema.mid  = ema.mid  * (1 - EMA_ALPHA) + raw.mid  * EMA_ALPHA;
      ema.high = ema.high * (1 - EMA_ALPHA) + raw.high * EMA_ALPHA;
      bass = ema.bass; mid = ema.mid; high = ema.high;
    }

    chromeUniforms.uTime.value = performance.now() / 1000;
    chromeUniforms.uBass.value = bass;
    chromeUniforms.uHigh.value = high;

    if (chromaPass) chromaPass.uniforms.uStrength.value = 0.002 + high * 0.004;

    updateParticles(mid);
    composer.render();
  }

  animate();
}
