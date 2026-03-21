/** Morphics Landing Page Visualizer
 *  Three.js WebGL audio-reactive: tendril plane + 3D blob + particle field
 *  Spec: docs/superpowers/specs/2026-03-21-landing-visualizer-redesign.md
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createMatcapCanvas } from './matcap.js';

// ---------------------------------------------------------------------------
// Shader source
// ---------------------------------------------------------------------------

const VERT_TENDRIL = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// OCTAVES is injected via ShaderMaterial.defines (5 desktop, 3 mobile)
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
  gl_FragColor = vec4(0.816, 0.91, 0.91, tex.a * vOpacity);
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
  g.addColorStop(0, 'rgba(208,232,232,1)');
  g.addColorStop(1, 'rgba(208,232,232,0)');
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

  // --- Tendril background plane (L1 + L2) ---
  const tendrilUniforms = {
    uTime: { value: 0 },
    uBass: { value: AMBIENT.bass },
    uMid:  { value: AMBIENT.mid },
    uHigh: { value: AMBIENT.high },
  };
  const { w: planeW, h: planeH } = getViewportPlaneSize(camera, -0.5);
  const tendrilMat = new THREE.ShaderMaterial({
    uniforms:       tendrilUniforms,
    vertexShader:   VERT_TENDRIL,
    fragmentShader: FRAG_TENDRIL,
    defines:        { OCTAVES: isMobile ? 3 : 5 },
  });
  const tendrilMesh = new THREE.Mesh(new THREE.PlaneGeometry(planeW, planeH), tendrilMat);
  tendrilMesh.position.z = -0.5;
  tendrilMesh.renderOrder = 0;
  scene.add(tendrilMesh);

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

  // --- Particles ---
  const particleCount = isMobile ? 400 : 1500;
  const positions     = new Float32Array(particleCount * 3);
  const homePos       = new Float32Array(particleCount * 3);
  const velocities    = new Float32Array(particleCount * 3); // zero-initialized
  const sizes         = new Float32Array(particleCount);
  const opacities     = new Float32Array(particleCount);

  for (let i = 0; i < particleCount; i++) {
    const [x, y] = gaussian(SIGMA);
    const [, z] = gaussian(SIGMA * 0.3);
    homePos[i*3]   = positions[i*3]   = x;
    homePos[i*3+1] = positions[i*3+1] = y;
    homePos[i*3+2] = positions[i*3+2] = z;
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
    depthTest:      true,
  });
  const particlePoints = new THREE.Points(particleGeo, particleMat);
  particlePoints.renderOrder = 2;
  scene.add(particlePoints);

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
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    // Re-scale tendril plane to fill viewport at its z-depth
    const { w: pw, h: ph } = getViewportPlaneSize(camera, tendrilMesh.position.z);
    tendrilMesh.geometry.dispose();
    tendrilMesh.geometry = new THREE.PlaneGeometry(pw, ph);
  }
  window.addEventListener('resize', onResize);

  // --- Render loop ---
  function animate() {
    requestAnimationFrame(animate);

    const analyser = getAnalyserFn();
    let bass = AMBIENT.bass, mid = AMBIENT.mid, high = AMBIENT.high;

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

    tendrilUniforms.uTime.value = performance.now() / 1000;
    tendrilUniforms.uBass.value = bass;
    tendrilUniforms.uMid.value  = mid;
    tendrilUniforms.uHigh.value = high;

    blobUniforms.uTime.value = performance.now() / 1000;
    blobUniforms.uBass.value = bass;
    blobUniforms.uMid.value  = mid;

    if (chromaPass) chromaPass.uniforms.uStrength.value = 0.002 + high * 0.004;

    updateParticles(mid);
    composer.render();
  }

  animate();
}
