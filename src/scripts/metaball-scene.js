/**
 * Morphics — Raymarched SDF metaball scene
 * Three.js fullscreen quad + custom GLSL
 * Audio-reactive: volume-gated — quiet = calm sphere, loud = full deformation
 * Color palettes + procedural skin textures cycle on track change
 */

import * as THREE from 'three';

/* ─── Vertex shader ─── */
const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

/* ─── Fragment shader ─── */
const fragmentShader = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec2  uResolution;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uMasterEnergy;
uniform float uPeakEnergy;
uniform vec3  uBaseColor;
uniform vec3  uRimColor;
uniform vec3  uSpecColor;
uniform int   uSkinFrom;
uniform int   uSkinTo;
uniform float uSkinMix;
uniform float uKickGlow;
uniform float uKickGlowSlow;
uniform float uTendrilStr;    // 0-1 how extended tendrils are
uniform float uTendrilPhase;  // rotation phase for tendril directions
uniform float uMorphIntensity; // 0-1 how bizarre the overall shape gets
uniform float uStereoWidth;
uniform float uPan;

#define MAX_STEPS 80
#define MAX_DIST  20.0
#define SURF_DIST 0.003
#define NUM_BALLS 7

/* ── Simplex 3D noise (Ashima Arts / Stefan Gustavson) ── */
vec3 mod289(vec3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x*34.0)+10.0)*x); }
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
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x  = x_ * ns.x + ns.yyyy;
  vec4 y  = y_ * ns.x + ns.yyyy;
  vec4 h  = 1.0 - abs(x) - abs(y);
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
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

/* ── Hash for cheap pseudo-random (voronoi seeds) ── */
vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453);
}

/* ── Smooth minimum (polynomial) ── */
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5*(a - b)/k, 0.0, 1.0);
  return mix(a, b, h) - k*h*(1.0 - h);
}

/* ══════════════════════════════════════════════════════
   SKIN SYSTEM — procedural surface textures
   Each returns: vec3(pattern, specBoost, 0)
   pattern  = 0-1 intensity (modulates base→rim color)
   specBoost = additive specular multiplier
   ══════════════════════════════════════════════════════ */

// Analytical voronoi — single nearest cell (no neighbor search)
vec2 voronoiFast(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float dMin = 1.0;
  float dEdge = 1.0;
  for (int x = -1; x <= 1; x++)
  for (int y = -1; y <= 1; y++)
  for (int z = -1; z <= 1; z++) {
    vec3 off = vec3(float(x), float(y), float(z));
    vec3 r = off + hash3(i + off) - f;
    float d = dot(r, r);
    if (d < dMin) { dEdge = dMin; dMin = d; }
    else if (d < dEdge) { dEdge = d; }
  }
  return vec2(sqrt(dMin), sqrt(dEdge) - sqrt(dMin));
}

// 0: Chameleon — irregular voronoi cells with color shift
vec3 skinChameleon(vec3 p) {
  vec3 wp = p * 4.0 + snoise(p * 2.0 + uTime * 0.1) * 0.4;
  vec2 v = voronoiFast(wp);
  float cells = smoothstep(0.0, 0.6, v.x);
  float edge = 1.0 - smoothstep(0.0, 0.08, v.y);
  float pattern = cells * 0.6 + sin(v.x * 12.0) * 0.15;
  return vec3(pattern, edge * 0.3, 0.0);
}

// 1: Stardust — fine sparkle grain via high-freq noise layers
vec3 skinStardust(vec3 p) {
  float n1 = snoise(p * 18.0 + uTime * 0.05);
  float n2 = snoise(p * 32.0 - uTime * 0.03);
  float grain = n1 * 0.6 + n2 * 0.4;
  float pattern = smoothstep(-0.1, 0.4, grain);
  float sparkle = pow(max(grain, 0.0), 3.0);
  return vec3(pattern * 0.35, sparkle * 0.6, 0.0);
}

// 2: Tiger — warped parallel stripes following surface
vec3 skinTiger(vec3 p, vec3 n) {
  float warp = snoise(p * 2.0 + uTime * 0.08) * 1.2;
  float stripe = sin((p.y * 6.0 + p.x * 2.0 + warp) * 3.14159);
  float pattern = smoothstep(-0.2, 0.2, stripe);
  float edge = 1.0 - abs(stripe);
  edge = pow(max(edge, 0.0), 4.0);
  return vec3(pattern * 0.7, edge * 0.2, 0.0);
}

// 3: Obsidian — cracked volcanic glass
vec3 skinObsidian(vec3 p) {
  vec3 wp = p * 5.0;
  vec2 v = voronoiFast(wp);
  float crack = 1.0 - smoothstep(0.0, 0.06, v.y);
  float face = smoothstep(0.1, 0.5, v.x) * 0.15;
  return vec3(face, crack * 0.8, 0.0);
}

// 4: Coral — porous organic holes
vec3 skinCoral(vec3 p) {
  vec3 wp = p * 5.5 + snoise(p * 3.0) * 0.3;
  vec2 v = voronoiFast(wp);
  float pore = 1.0 - smoothstep(0.1, 0.35, v.x);
  float rim = smoothstep(0.08, 0.15, v.x) * (1.0 - smoothstep(0.15, 0.35, v.x));
  return vec3(pore * 0.6, rim * 0.35, 0.0);
}

// 5: Mercury — liquid metal concentric ripples
vec3 skinMercury(vec3 p) {
  float d = length(p) + snoise(p * 3.0 + uTime * 0.15) * 0.2;
  float rings = sin(d * 18.0 + uTime * 0.8) * 0.5 + 0.5;
  float ripple = sin(d * 30.0 - uTime * 1.2) * 0.5 + 0.5;
  float pattern = rings * 0.5 + ripple * 0.2;
  float spec = pow(rings, 3.0);
  return vec3(pattern, spec * 0.6, 0.0);
}

// 6: Moth — soft overlapping powdery wing scales
vec3 skinMoth(vec3 p) {
  vec3 wp = p * 7.0 + snoise(p * 1.8 + uTime * 0.04) * 0.3;
  vec2 v1 = voronoiFast(wp);
  vec2 v2 = voronoiFast(wp * 0.6 + 3.0);
  float scales = smoothstep(0.05, 0.25, v1.x) * smoothstep(0.08, 0.3, v2.x);
  float dust = snoise(p * 20.0 + uTime * 0.02) * 0.5 + 0.5;
  float pattern = scales * 0.55 + dust * 0.15;
  float sheen = pow(1.0 - smoothstep(0.0, 0.15, v1.y), 3.0) * 0.4;
  return vec3(pattern, sheen, 0.0);
}

// 7: Plasma — swirling energy vortex
vec3 skinPlasma(vec3 p) {
  float a = atan(p.z, p.x) + uTime * 0.12;
  float d = length(p.xz);
  float swirl = sin(a * 3.0 + d * 8.0 + snoise(p * 2.5 + uTime * 0.1) * 1.5) * 0.5 + 0.5;
  float vortex = sin(a * 5.0 - d * 12.0 + uTime * 0.3) * 0.5 + 0.5;
  float pattern = swirl * 0.6 + vortex * 0.3;
  float glow = pow(swirl, 4.0);
  return vec3(pattern, glow * 0.5, 0.0);
}

// 8: Mycelium — branching organic network
vec3 skinMycelium(vec3 p) {
  vec3 wp = p * 4.5 + snoise(p * 1.5 + uTime * 0.05) * 0.6;
  vec2 v = voronoiFast(wp);
  float branch = smoothstep(0.02, 0.12, v.y);
  float node = 1.0 - smoothstep(0.0, 0.2, v.x);
  float pattern = (1.0 - branch) * 0.7 + node * 0.3;
  float spec = (1.0 - branch) * 0.5;
  return vec3(pattern, spec, 0.0);
}

// 9: Beetle — iridescent chitin plates with hard edges
vec3 skinBeetle(vec3 p) {
  vec3 wp = p * 5.5;
  vec2 v = voronoiFast(wp);
  // Hard chitin plates with sharp ridges between them
  float plate = smoothstep(0.1, 0.4, v.x);
  float ridge = 1.0 - smoothstep(0.0, 0.05, v.y);
  // Iridescent shimmer within each plate
  float shimmer = sin(v.x * 25.0 + p.y * 8.0 + uTime * 0.15) * 0.5 + 0.5;
  float pattern = plate * 0.4 + shimmer * plate * 0.25;
  float spec = ridge * 0.6 + shimmer * 0.3;
  return vec3(pattern, spec, 0.0);
}

// Dispatch skin by ID
vec3 evalSkin(int id, vec3 p, vec3 n) {
  if (id == 0) return skinChameleon(p);
  if (id == 1) return skinStardust(p);
  if (id == 2) return skinTiger(p, n);
  if (id == 3) return skinObsidian(p);
  if (id == 4) return skinCoral(p);
  if (id == 5) return skinMercury(p);
  if (id == 6) return skinMoth(p);
  if (id == 7) return skinPlasma(p);
  if (id == 8) return skinMycelium(p);
  if (id == 9) return skinBeetle(p);
  return vec3(0.0);
}

/* ── Metaball positions — energy-gated orbital spread ── */
vec3 ballPos(int i, float t, float bass, float me) {
  float fi = float(i);
  // Center ball: gentle drift only
  if (i == 0) {
    return vec3(
      sin(t * 0.15) * 0.08,
      sin(t * 0.12 + 0.5) * 0.08,
      sin(t * 0.1 + 1.0) * 0.08
    );
  }
  // Speed: 15% at silence → 100% at full energy
  float speed = 0.15 + me * 0.85;
  float angle = fi * 1.047 + t * (0.18 + fi * 0.04) * speed;
  // Orbital radius: gentle curve — some spread at moderate energy, full at loud
  float spread = me;
  float r = (0.65 + sin(t * 0.25 * speed + fi * 1.7) * 0.2) * spread;
  float bassX = bass * 0.55;
  float bassY = bass * 1.0;
  // Orbital position
  float xPos = cos(angle) * r + cos(angle) * bassX;
  float yBase = sin(t * 0.3 * speed + fi * 2.1) * 0.45 * spread;
  float yReactive = sin(t * 0.5 * speed + fi * 1.3) * bassY + cos(t * 0.2 * speed + fi) * bassY * 0.6;
  float zPos = sin(angle) * r * 0.5 + cos(angle + t * 0.1 * speed) * r * 0.2;
  // Lerp between center (perfect sphere) and orbital position
  vec3 orbitPos = vec3(xPos, yBase + yReactive, zPos);
  return mix(vec3(0.0), orbitPos, me);
}

float ballRadius(int i) {
  if (i == 0) return 0.65;
  if (i == 1) return 0.42;
  if (i == 2) return 0.38;
  if (i == 3) return 0.45;
  if (i == 4) return 0.35;
  if (i == 5) return 0.40;
  return 0.33;
}

/* ── Scene SDF ── */
float sceneSDF(vec3 p) {
  float t = uTime;
  float bass = uBass;
  float me = uMasterEnergy;
  float pe = uPeakEnergy;

  // Blend K: keep smooth blending — never go too sharp to avoid holes
  float blendK = mix(0.85, 0.55, me) + bass * 0.4 * me;

  // Noise displacement: energy-gated — gentler to prevent surface holes
  float noiseGate = pe * 0.85 + pe * pe * 0.15;
  float noiseAmp = (0.06 + uMid * 0.2) * noiseGate;
  noiseAmp *= 1.0 + me * 0.3;
  float idleBreathe = sin(t * 0.3 * 6.2832) * 0.035 * (1.0 - me);
  // Use lower frequency noise for smoother surface undulation
  float n1 = snoise(p * 1.2 + t * 0.2);
  vec3 warp = vec3(
    n1,
    snoise(p * 1.2 + t * 0.2 + 100.0),
    snoise(p * 1.2 + t * 0.2 + 200.0)
  ) * noiseAmp;
  vec3 wp = p + warp;

  float d = 1e10;
  for (int i = 0; i < NUM_BALLS; i++) {
    vec3 center = ballPos(i, t, bass, me);
    float radius = ballRadius(i) * 1.1; // slightly larger balls to fill gaps
    d = smin(d, length(wp - center) - radius, blendK);
  }


  // Amoeba tendrils — thin elongated shapes that extend outward
  if (uTendrilStr > 0.01) {
    float ts = uTendrilStr;
    float phase = uTendrilPhase;
    float mi = uMorphIntensity;

    // 4 tendrils at different angles, each with organic motion
    for (int ti = 0; ti < 4; ti++) {
      float baseAngle = phase + float(ti) * 1.5708 + sin(t * 0.2 + float(ti)) * 0.5;
      float tendrilLen = (0.5 + mi * 1.5) * ts;

      // Tendril direction
      vec3 dir = vec3(cos(baseAngle), sin(baseAngle) * 0.7, sin(baseAngle + t * 0.3) * 0.3);

      // Capsule: elongated along direction
      vec3 a = dir * 0.2;
      vec3 b = dir * tendrilLen;

      // Point-to-segment distance for capsule SDF
      vec3 pa = p - a;
      vec3 ba = b - a;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      vec3 closest = a + ba * h;

      // Thickness tapers from base to tip
      float thickness = mix(0.25, 0.06, h) * ts;

      // Add organic wobble along the tendril
      float wobble = snoise(p * 2.0 + t * 0.4 + float(ti) * 50.0) * 0.08 * ts;
      float tendrilD = length(p - closest) - thickness + wobble;

      d = smin(d, tendrilD, 0.4 + (1.0 - ts) * 0.3);
    }

    // Extra bizarre morph: distort the whole SDF with additional noise when intensity is high
    if (mi > 0.3) {
      float bizarreNoise = snoise(p * 0.8 + t * 0.15) * mi * 0.15;
      d += bizarreNoise;
    }
  }

  // Idle breathing offset
  d -= idleBreathe;

  return d;
}

/* ── Normal via central differences ── */
vec3 getNormal(vec3 p) {
  float e = 0.002;
  return normalize(vec3(
    sceneSDF(p + vec3(e, 0, 0)) - sceneSDF(p - vec3(e, 0, 0)),
    sceneSDF(p + vec3(0, e, 0)) - sceneSDF(p - vec3(0, e, 0)),
    sceneSDF(p + vec3(0, 0, e)) - sceneSDF(p - vec3(0, 0, e))
  ));
}

/* ── Raymarch ── */
float raymarch(vec3 ro, vec3 rd) {
  float t = 0.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p = ro + rd * t;
    float d = sceneSDF(p);
    if (d < SURF_DIST) return t;
    t += d;
    if (t > MAX_DIST) break;
  }
  return -1.0;
}

/* ── Soft shadow ── */
float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float k) {
  float res = 1.0;
  float t = mint;
  for (int i = 0; i < 10; i++) {
    float d = sceneSDF(ro + rd * t);
    if (d < 0.001) return 0.0;
    res = min(res, k * d / t);
    t += clamp(d, 0.02, 0.2);
    if (t > maxt) break;
  }
  return clamp(res, 0.0, 1.0);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / min(uResolution.x, uResolution.y);

  vec3 ro = vec3(0.0, 0.0, 20.0);
  vec3 rd = normalize(vec3(uv, -4.5)); // still using per-pixel uv for correct aspect ratio

  float t = raymarch(ro, rd);

  vec3 col = vec3(0.0);
  float me = uMasterEnergy;

  if (t > 0.0) {
    vec3 p = ro + rd * t;
    vec3 n = getNormal(p);
    vec3 viewDir = normalize(ro - p);

    // Lighting
    vec3 light1Dir = normalize(vec3(1.2, 1.0, 0.8));
    vec3 light2Dir = normalize(vec3(-0.8, -0.3, 0.6));
    float diff1 = max(dot(n, light1Dir), 0.0);
    float diff2 = max(dot(n, light2Dir), 0.0) * 0.3;
    float shadow = softShadow(p + n * 0.02, light1Dir, 0.05, 3.0, 4.0);
    diff1 *= mix(shadow, 1.0, 0.5); // soften shadow — never fully dark

    // Evaluate blended skin
    vec3 skinA = evalSkin(uSkinFrom, p, n);
    vec3 skinB = evalSkin(uSkinTo, p, n);
    float smix = uSkinMix * uSkinMix * (3.0 - 2.0 * uSkinMix); // smoothstep
    vec3 skin = mix(skinA, skinB, smix);
    float pattern = skin.x;
    float specBoost = skin.y;

    // Colors modulated by skin pattern + subsurface warmth on kick (gated)
    vec3 baseColor = mix(uBaseColor, uRimColor, pattern * 0.5);
    vec3 specColor = uSpecColor;

    // Blinn-Phong specular — softened during kick glow
    vec3 halfDir1 = normalize(light1Dir + viewDir);
    float specExp1 = mix(48.0, 16.0, uKickGlow);  // soften exponent during pulse
    float spec1 = pow(max(dot(n, halfDir1), 0.0), specExp1);
    float specIntensity = (0.25 + uHigh * 0.75 + specBoost);
    spec1 *= specIntensity * shadow;

    vec3 halfDir2 = normalize(light2Dir + viewDir);
    float specExp2 = mix(24.0, 10.0, uKickGlow);
    float spec2 = pow(max(dot(n, halfDir2), 0.0), specExp2) * 0.15 * specIntensity;

    // Fresnel — rim scales with energy + kick bloom boost
    float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 3.5);
    float rimBase = mix(0.3, 1.0, me);
    float fresnelIntensity = (0.15 + uHigh * 0.6) * rimBase;
    // Kick rim bloom: strong fresnel boost
    float kickRimBoost = uKickGlow * fresnel * 0.6;
    fresnelIntensity += kickRimBoost;
    vec3 fresnelColor = mix(uRimColor, specColor, 0.4);

    // Kick color warmth: tint specular toward rim color during slow envelope
    vec3 warmSpec = mix(specColor, uRimColor, uKickGlowSlow * 0.25);

    float ambient = 0.40;

    // Core luminance: radial glow from center during kick
    float distFromCenter = length(p.xy);
    float coreGlow = uKickGlow * exp(-distFromCenter * 1.0) * 0.5;

    col = baseColor * (ambient + diff1 * 1.0 + diff2 * 0.45 + coreGlow)
        + warmSpec * (spec1 + spec2)
        + fresnelColor * fresnel * fresnelIntensity;

    float ao = 0.5 + 0.5 * snoise(p * 2.0 + uTime * 0.1);
    col *= 0.90 + ao * 0.10;

  }

  col = col / (1.0 + col * 0.14);
  float alpha = t > 0.0 ? 1.0 : 0.0;
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

/* ── Color palettes + skin mappings ── */
function hex(h) { return new THREE.Color(h); }

const THEMES = [
  { base: hex('#1aadad'), rim: hex('#30e0e0'), spec: hex('#e0be90'), skin: 0 }, // Teal Ember — Chameleon
  { base: hex('#6030a8'), rim: hex('#a870ff'), spec: hex('#f5c0ff'), skin: 1 }, // Violet Pulse — Stardust
  { base: hex('#a04818'), rim: hex('#ffa040'), spec: hex('#fff0a0'), skin: 2 }, // Solar Flare — Tiger
  { base: hex('#185080'), rim: hex('#60d8ff'), spec: hex('#e8f6ff'), skin: 3 }, // Arctic Drift — Obsidian
  { base: hex('#306030'), rim: hex('#78ffb0'), spec: hex('#e0ff90'), skin: 4 }, // Neon Moss — Coral
  { base: hex('#501818'), rim: hex('#ff4848'), spec: hex('#ffb8b8'), skin: 5 }, // Blood Moon — Mercury
  { base: hex('#301880'), rim: hex('#d080ff'), spec: hex('#f0e0ff'), skin: 6 }, // Rephractal — Moth (powdery wing scales)
  { base: hex('#186080'), rim: hex('#50f0ff'), spec: hex('#b8f8ff'), skin: 7 }, // Through Prisms — Plasma (cyan energy)
  { base: hex('#784818'), rim: hex('#ffbe38'), spec: hex('#fff8a0'), skin: 8 }, // Mirage — Mycelium (golden amber)
  { base: hex('#183060'), rim: hex('#90c8ff'), spec: hex('#a8d5ff'), skin: 9 }, // Synaptic Synthesis — Beetle (iridescent chitin)
];

const CANVAS_SIZE = Math.min(600, Math.round(window.innerWidth * 0.65));

/* ─── Scene setup ─── */
export function createMetaballScene(container, getAnalyser, getStereoAnalysers) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(CANVAS_SIZE, CANVAS_SIZE);
  renderer.setClearColor(0x000000, 0);

  const canvas = renderer.domElement;
  canvas.style.cssText = `
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    opacity: 0;
    transition: opacity 2.5s ease;
    pointer-events: none;
    z-index: 2;
  `;

  // Shadow behind glob — always visible, creates depth separation
  const shadowEl = document.createElement('div');
  shadowEl.style.cssText = `
    position: absolute;
    top: 50%; left: 50%;
    width: ${CANVAS_SIZE * 1.4}px; height: ${CANVAS_SIZE * 1.4}px;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    background: radial-gradient(circle, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.6) 25%, rgba(0,0,0,0.2) 50%, transparent 70%);
    pointer-events: none;
    z-index: 1;
    opacity: 0;
    transition: opacity 2.5s ease;
  `;


  // Nebula pulse canvas — renders gaseous ring behind the metaball
  const pulseCanvas = document.createElement('canvas');
  const PULSE_W = window.innerWidth;
  const PULSE_H = window.innerHeight;
  pulseCanvas.width = PULSE_W;
  pulseCanvas.height = PULSE_H;
  pulseCanvas.style.cssText = `
    position: absolute;
    top: 0; left: 0;
    width: ${PULSE_W}px; height: ${PULSE_H}px;
    pointer-events: none;
    z-index: 0;
    mix-blend-mode: screen;
  `;
  const pulseCtx = pulseCanvas.getContext('2d');
  container.appendChild(pulseCanvas);

  container.appendChild(shadowEl);
  container.appendChild(canvas);

  // Pulse state
  let pulseActive = false;
  let firstKickTime = 0;
  let lastKickHeard = 0;
  let nextPulseTime = 0;
  let pulseCount = 0;
  let lastSnarePulseTime = 0;
  let lastHighPulseTime = 0;
  let lastSurgePulseTime = 0;
  let lastDropPulseTime = 0;

  // Active pulse rings being animated
  const activePulses = [];

  function getColors() {
    const base = uniforms.uBaseColor.value;
    const rim = uniforms.uRimColor.value;
    return {
      r1: Math.round(rim.r * 255), g1: Math.round(rim.g * 255), b1: Math.round(rim.b * 255),
      r2: Math.round(base.r * 255), g2: Math.round(base.g * 255), b2: Math.round(base.b * 255),
    };
  }



  // ── TYPE 3: Solar Flare — large asymmetric gas clouds erupting outward ──
  function fireSolarFlare() {
    const c = getColors();
    const pulse = { type: 'flare', startTime: performance.now(), duration: 5000, clouds: [], ...c };
    const cloudCount = 5 + Math.floor(Math.random() * 4);
    for (let i = 0; i < cloudCount; i++) {
      const baseAngle = Math.random() * Math.PI * 2;
      pulse.clouds.push({
        angle: baseAngle,
        spread: 0.3 + Math.random() * 0.5,
        size: 60 + Math.random() * 100,
        brightness: 0.5 + Math.random() * 0.5,
        useRim: Math.random() > 0.3,
        speed: 0.6 + Math.random() * 0.8,
        drift: (Math.random() - 0.5) * 0.4,
      });
    }
    activePulses.push(pulse);
  }

  // ── TYPE 4: Stardust Scatter — tiny particles explode outward, triggered by energy surges ──
  function fireStardust() {
    const c = getColors();
    const pulse = { type: 'stardust', startTime: performance.now(), duration: 3000, particles: [], ...c };
    for (let i = 0; i < 80; i++) {
      const angle = Math.random() * Math.PI * 2;
      pulse.particles.push({
        angle,
        speed: 0.5 + Math.random() * 1.5,
        size: 1 + Math.random() * 4,
        brightness: 0.3 + Math.random() * 0.7,
        useRim: Math.random() > 0.5,
        wobble: (Math.random() - 0.5) * 2,
      });
    }
    activePulses.push(pulse);
  }

  // ── TYPE 5: Plasma Bloom — soft growing glow, triggered by energy drop (silence after loud) ──
  function firePlasmaBloom() {
    const c = getColors();
    const pulse = { type: 'bloom', startTime: performance.now(), duration: 10000, ...c };
    activePulses.push(pulse);
  }

  function firePulse() { firePlasmaBloom(); }

  // ── Wandering ambient lights — always-on drifting glows ──
  const wanderers = [];
  const MAX_WANDERERS = 12;
  for (let w = 0; w < MAX_WANDERERS; w++) {
    wanderers.push({
      x: Math.random() * PULSE_W,
      y: Math.random() * PULSE_H,
      vx: (Math.random() - 0.5) * 0.5,
      vy: (Math.random() - 0.5) * 0.5,
      size: 30 + Math.random() * 90,
      brightness: 0,
      targetBrightness: 0,
      useRim: Math.random() > 0.4,
      phaseX: Math.random() * Math.PI * 2,
      phaseY: Math.random() * Math.PI * 2,
      speedX: 0.15 + Math.random() * 0.25,
      speedY: 0.12 + Math.random() * 0.2,
      fadeTimer: Math.random() * 10000,
      fadeDur: 3000 + Math.random() * 5000,
    });
  }

  function tickWanderers(now) {
    const c = getColors();
    const t = now / 1000;
    for (const w of wanderers) {
      // Center gravity — gently pull toward center
      const centerPullX = (PULSE_W / 2 - w.x) * 0.0003;
      const centerPullY = (PULSE_H / 2 - w.y) * 0.0003;
      w.vx += centerPullX;
      w.vy += centerPullY;

      // Smooth drift with sine wander — more movement
      w.x += Math.sin(t * w.speedX + w.phaseX) * 0.8 + w.vx;
      w.y += Math.sin(t * w.speedY + w.phaseY) * 0.7 + w.vy;

      // Bounce off edges
      if (w.x < 20) { w.x = 20; w.vx = Math.abs(w.vx) + Math.random() * 0.3; w.targetBrightness = 0.15 + Math.random() * 0.2; }
      if (w.x > PULSE_W - 20) { w.x = PULSE_W - 20; w.vx = -Math.abs(w.vx) - Math.random() * 0.3; w.targetBrightness = 0.15 + Math.random() * 0.2; }
      if (w.y < 20) { w.y = 20; w.vy = Math.abs(w.vy) + Math.random() * 0.2; w.targetBrightness = 0.12 + Math.random() * 0.15; }
      if (w.y > PULSE_H - 20) { w.y = PULSE_H - 20; w.vy = -Math.abs(w.vy) - Math.random() * 0.2; w.targetBrightness = 0.12 + Math.random() * 0.15; }

      // Velocity damping
      w.vx *= 0.995;
      w.vy *= 0.995;

      // Random fade in/out cycle
      w.fadeTimer += 16;
      if (w.fadeTimer > w.fadeDur) {
        w.fadeTimer = 0;
        w.fadeDur = 4000 + Math.random() * 8000;
        w.targetBrightness = 0.08 + Math.random() * 0.22;
        w.useRim = Math.random() > 0.4;
      }
      w.brightness += (w.targetBrightness - w.brightness) * 0.01;

      if (w.brightness < 0.01) continue;

      const cr = w.useRim ? c.r1 : c.r2;
      const cg = w.useRim ? c.g1 : c.g2;
      const cb = w.useRim ? c.b1 : c.b2;
      const sz = w.size * (1 + Math.sin(t * 0.3 + w.phaseX) * 0.3);
      const a = w.brightness;

      const grad = pulseCtx.createRadialGradient(w.x, w.y, 0, w.x, w.y, sz);
      grad.addColorStop(0, `rgba(${cr},${cg},${cb},${(a * 0.4).toFixed(3)})`);
      grad.addColorStop(0.3, `rgba(${cr},${cg},${cb},${(a * 0.2).toFixed(3)})`);
      grad.addColorStop(0.7, `rgba(${cr},${cg},${cb},${(a * 0.05).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      pulseCtx.fillStyle = grad;
      pulseCtx.beginPath(); pulseCtx.arc(w.x, w.y, sz, 0, Math.PI * 2); pulseCtx.fill();
    }
  }

  function tickPulses() {
    const cx = PULSE_W / 2;
    const cy = PULSE_H / 2;
    const maxDim = Math.max(PULSE_W, PULSE_H);
    const now = performance.now();

    for (let p = activePulses.length - 1; p >= 0; p--) {
      const pulse = activePulses[p];
      const elapsed = now - pulse.startTime;
      const t = elapsed / pulse.duration;
      if (t > 1) { activePulses.splice(p, 1); continue; }

      const fadeIn = Math.min(t / 0.1, 1);
      const fadeOut = t > 0.2 ? Math.max(0, 1 - (t - 0.2) / 0.8) : 1;
      const alpha = fadeIn * fadeOut * 0.45; // global brightness reduction

      // Glow expansion factor — glow grows as pulse travels outward
      const glowGrow = 1 + t * 2; // 1x at center → 3x at edge

      if (pulse.type === 'flare') {
        const maxR = maxDim * 0.5;
        const baseR = 30 + t * maxR;
        for (const cloud of pulse.clouds) {
          const ang = cloud.angle + t * cloud.drift;
          const r = baseR * cloud.speed;
          const cloudCx = cx + Math.cos(ang) * r;
          const cloudCy = cy + Math.sin(ang) * r;
          const sz = cloud.size * (1.5 + t * 2.5) * glowGrow;
          const cr = cloud.useRim ? pulse.r1 : pulse.r2, cg = cloud.useRim ? pulse.g1 : pulse.g2, cb = cloud.useRim ? pulse.b1 : pulse.b2;
          const a = alpha * cloud.brightness;
          for (let sub = 0; sub < 3; sub++) {
            const ox = Math.sin(t * 3 + sub * 2 + cloud.angle) * sz * 0.2;
            const oy = Math.cos(t * 2.5 + sub * 1.7 + cloud.angle) * sz * 0.15;
            const subSz = sz * (0.6 + sub * 0.25);
            const subA = a * (0.45 - sub * 0.1);
            const grad = pulseCtx.createRadialGradient(cloudCx + ox, cloudCy + oy, 0, cloudCx + ox, cloudCy + oy, subSz);
            grad.addColorStop(0, `rgba(${cr},${cg},${cb},${subA.toFixed(3)})`);
            grad.addColorStop(0.25, `rgba(${cr},${cg},${cb},${(subA * 0.5).toFixed(3)})`);
            grad.addColorStop(0.6, `rgba(${cr},${cg},${cb},${(subA * 0.15).toFixed(3)})`);
            grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
            pulseCtx.fillStyle = grad;
            pulseCtx.beginPath(); pulseCtx.arc(cloudCx + ox, cloudCy + oy, subSz, 0, Math.PI * 2); pulseCtx.fill();
          }
        }

      } else if (pulse.type === 'stardust') {
        const maxR = maxDim * 0.55;
        for (const pt of pulse.particles) {
          const r = 10 + t * maxR * pt.speed;
          const wobbleAng = pt.angle + Math.sin(t * 5 + pt.wobble) * 0.15;
          const px = cx + Math.cos(wobbleAng) * r, py = cy + Math.sin(wobbleAng) * r;
          const baseSz = pt.size * 2;
          const sz = baseSz * glowGrow;
          const cr = pt.useRim ? pulse.r1 : pulse.r2, cg = pt.useRim ? pulse.g1 : pulse.g2, cb = pt.useRim ? pulse.b1 : pulse.b2;
          const a = alpha * pt.brightness;
          const haloR = sz * (2 + t * 2);
          const grad = pulseCtx.createRadialGradient(px, py, 0, px, py, haloR);
          grad.addColorStop(0, `rgba(${cr},${cg},${cb},${(a * 0.5).toFixed(3)})`);
          grad.addColorStop(0.2, `rgba(${cr},${cg},${cb},${(a * 0.25).toFixed(3)})`);
          grad.addColorStop(0.5, `rgba(${cr},${cg},${cb},${(a * 0.08).toFixed(3)})`);
          grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
          pulseCtx.fillStyle = grad;
          pulseCtx.beginPath(); pulseCtx.arc(px, py, haloR, 0, Math.PI * 2); pulseCtx.fill();
        }

      } else if (pulse.type === 'bloom') {
        const maxR = maxDim * 0.5;
        const easeT = t < 0.3 ? (t / 0.3) : 1;
        const bloomR = easeT * maxR * glowGrow;
        const fadeBloom = t > 0.15 ? Math.max(0, 1 - (t - 0.15) / 0.85) : 1;
        for (let layer = 0; layer < 6; layer++) {
          const lr = bloomR * (0.3 + layer * 0.2);
          const la = fadeBloom * (0.3 - layer * 0.035);
          const cr = layer % 2 === 0 ? pulse.r1 : pulse.r2;
          const cg = layer % 2 === 0 ? pulse.g1 : pulse.g2;
          const cb = layer % 2 === 0 ? pulse.b1 : pulse.b2;
          const grad = pulseCtx.createRadialGradient(cx, cy, 0, cx, cy, lr);
          grad.addColorStop(0, `rgba(${cr},${cg},${cb},${la.toFixed(3)})`);
          grad.addColorStop(0.3, `rgba(${cr},${cg},${cb},${(la * 0.6).toFixed(3)})`);
          grad.addColorStop(0.7, `rgba(${cr},${cg},${cb},${(la * 0.2).toFixed(3)})`);
          grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
          pulseCtx.fillStyle = grad;
          pulseCtx.beginPath(); pulseCtx.arc(cx, cy, lr, 0, Math.PI * 2); pulseCtx.fill();
        }
      }
    }
  }

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const scene = new THREE.Scene();
  const geometry = new THREE.PlaneGeometry(2, 2);

  // ── Particle scene: perspective camera matching the shader's virtual camera ──
  // Shader uses ro=(0,0,20), rd=normalize(uv, -4.5). FOV = 2*atan(1/4.5) ≈ 25.1°
  const particleFOV = 2 * Math.atan(1.0 / 4.5) * (180 / Math.PI);
  const particleCam = new THREE.PerspectiveCamera(particleFOV, 1, 0.1, 50);
  particleCam.position.set(0, 0, 20);
  particleCam.lookAt(0, 0, 0);
  const particleScene = new THREE.Scene();

  // Particle pool — max 300 particles, reused via ring buffer
  const MAX_PARTICLES = 300;
  const PARTICLES_PER_BURST = 18;
  const pPositions = new Float32Array(MAX_PARTICLES * 3);
  const pVelocities = new Float32Array(MAX_PARTICLES * 3);
  const pLifetimes = new Float32Array(MAX_PARTICLES);    // 0 = dead
  const pMaxLifetimes = new Float32Array(MAX_PARTICLES);
  const pSizes = new Float32Array(MAX_PARTICLES);
  let pNextIdx = 0;

  const pGeometry = new THREE.BufferGeometry();
  pGeometry.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));
  pGeometry.setAttribute('aLife', new THREE.BufferAttribute(pLifetimes, 1));
  pGeometry.setAttribute('aMaxLife', new THREE.BufferAttribute(pMaxLifetimes, 1));
  pGeometry.setAttribute('aSize', new THREE.BufferAttribute(pSizes, 1));

  const particleVert = /* glsl */ `
    attribute float aLife;
    attribute float aMaxLife;
    attribute float aSize;
    varying float vAlpha;
    void main() {
      float t = 1.0 - (aLife / max(aMaxLife, 0.001));
      // Fast initial fade then slow tail — solar flare dissipation
      vAlpha = aLife > 0.0 ? exp(-t * 2.5) * (1.0 - t * t) : 0.0;
      vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * (1.0 + t * 0.5) * (300.0 / -mvPos.z);
      gl_Position = projectionMatrix * mvPos;
    }
  `;
  const particleFrag = /* glsl */ `
    uniform vec3 uParticleColor;
    varying float vAlpha;
    void main() {
      // Soft circle with bright core
      float d = length(gl_PointCoord - 0.5) * 2.0;
      float core = exp(-d * d * 3.0);
      float glow = exp(-d * d * 0.8) * 0.4;
      float alpha = (core + glow) * vAlpha;
      if (alpha < 0.005) discard;
      // Hot core (white) → rim color at edges
      vec3 col = mix(uParticleColor, vec3(1.0), core * 0.6);
      gl_FragColor = vec4(col, alpha);
    }
  `;

  const particleMat = new THREE.ShaderMaterial({
    vertexShader: particleVert,
    fragmentShader: particleFrag,
    uniforms: {
      uParticleColor: { value: new THREE.Color() },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const particlePoints = new THREE.Points(pGeometry, particleMat);
  particleScene.add(particlePoints);

  function spawnBurst(rimColor) {
    // Random point on sphere surface (blob radius ~1.2)
    const blobRadius = 1.2;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const nx = Math.sin(phi) * Math.cos(theta);
    const ny = Math.sin(phi) * Math.sin(theta);
    const nz = Math.cos(phi);
    const ox = nx * blobRadius;
    const oy = ny * blobRadius;
    const oz = nz * blobRadius;

    for (let i = 0; i < PARTICLES_PER_BURST; i++) {
      const idx = pNextIdx;
      pNextIdx = (pNextIdx + 1) % MAX_PARTICLES;

      // Start at surface
      const i3 = idx * 3;
      pPositions[i3]     = ox + (Math.random() - 0.5) * 0.15;
      pPositions[i3 + 1] = oy + (Math.random() - 0.5) * 0.15;
      pPositions[i3 + 2] = oz + (Math.random() - 0.5) * 0.15;

      // Velocity: outward from surface + random spread
      const speed = 1.5 + Math.random() * 3.0;
      const spreadX = (Math.random() - 0.5) * 0.6;
      const spreadY = (Math.random() - 0.5) * 0.6;
      const spreadZ = (Math.random() - 0.5) * 0.6;
      pVelocities[i3]     = (nx + spreadX) * speed;
      pVelocities[i3 + 1] = (ny + spreadY) * speed;
      pVelocities[i3 + 2] = (nz + spreadZ) * speed;

      // Lifetime: 0.8-2.0 seconds
      const life = 0.8 + Math.random() * 1.2;
      pLifetimes[idx] = life;
      pMaxLifetimes[idx] = life;
      pSizes[idx] = 2.0 + Math.random() * 4.0;
    }

    // Set particle color to current theme rim
    particleMat.uniforms.uParticleColor.value.copy(rimColor);
  }

  function tickParticles(dt) {
    let anyAlive = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (pLifetimes[i] <= 0) continue;
      anyAlive = true;
      pLifetimes[i] -= dt;
      if (pLifetimes[i] <= 0) {
        pLifetimes[i] = 0;
        // Move dead particles offscreen
        const i3 = i * 3;
        pPositions[i3] = 0;
        pPositions[i3 + 1] = 0;
        pPositions[i3 + 2] = -100;
        continue;
      }
      const i3 = i * 3;
      // Decelerate over time (drag)
      const drag = 0.97;
      pVelocities[i3]     *= drag;
      pVelocities[i3 + 1] *= drag;
      pVelocities[i3 + 2] *= drag;
      pPositions[i3]     += pVelocities[i3]     * dt;
      pPositions[i3 + 1] += pVelocities[i3 + 1] * dt;
      pPositions[i3 + 2] += pVelocities[i3 + 2] * dt;
    }
    pGeometry.attributes.position.needsUpdate = true;
    pGeometry.attributes.aLife.needsUpdate = true;
    pGeometry.attributes.aMaxLife.needsUpdate = true;
    pGeometry.attributes.aSize.needsUpdate = true;
    return anyAlive;
  }

  const t0 = THEMES[0];
  const uniforms = {
    uTime:             { value: 0 },
    uResolution:       { value: new THREE.Vector2() },
    uBass:             { value: 0 },
    uMid:              { value: 0 },
    uHigh:             { value: 0 },
    uMasterEnergy:     { value: 0 },
    uPeakEnergy:       { value: 0 },
    uBaseColor:        { value: t0.base.clone() },
    uRimColor:         { value: t0.rim.clone() },
    uSpecColor:        { value: t0.spec.clone() },
    uSkinFrom:         { value: t0.skin },
    uSkinTo:           { value: t0.skin },
    uSkinMix:          { value: 1.0 },
    uKickGlow:         { value: 0 },
    uKickGlowSlow:     { value: 0 },
    uStereoWidth:      { value: 0 },
    uPan:              { value: 0 },
    uTendrilStr:       { value: 0 },
    uTendrilPhase:     { value: 0 },
    uMorphIntensity:   { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
  });
  scene.add(new THREE.Mesh(geometry, material));

  const pr = renderer.getPixelRatio();
  uniforms.uResolution.value.set(CANVAS_SIZE * pr, CANVAS_SIZE * pr);

  // Pre-compile shader to avoid first-frame jank
  try { renderer.compile(scene, camera); } catch (_) {}

  // Audio band extraction — raw values (pre-gating)
  const ema = { bass: 0, mid: 0, high: 0 };
  const freqData = new Uint8Array(1024);

  function readBands() {
    const analyser = getAnalyser();
    if (!analyser) return;
    analyser.getByteFrequencyData(freqData);
    let bass = 0, mid = 0, high = 0;
    for (let i = 0;  i < 10;  i++) bass += freqData[i];
    for (let i = 10; i < 93;  i++) mid  += freqData[i];
    for (let i = 93; i < 930; i++) high += freqData[i];
    const raw = {
      bass: bass / (10 * 255),
      mid:  mid  / (83 * 255),
      high: high / (837 * 255),
    };
    ema.bass += 0.25 * (raw.bass - ema.bass);
    ema.mid  += 0.2  * (raw.mid  - ema.mid);
    ema.high += 0.2  * (raw.high - ema.high);
  }

  // ── Energy surge state — sustained high energy triggers horizontal drift ──
  let sustainedEnergy = 0;       // smoothed sustained energy level
  let energySurgeDir = 0;        // -1 or 1, current drift direction
  let energySurgeDrift = 0;      // current horizontal offset in px
  let lastSurgeTime = 0;         // when last surge direction change happened
  let surgeThreshold = 0.45;     // energy level to trigger a surge

  // ── Volume gate state ──
  let masterEnergy = 0;   // slow-lerp pow(rms, 2.8)
  let peakEnergy = 0;     // fast-lerp pow(rms, 2.8)
  let currentRMS = 0;     // raw RMS for kick threshold scaling

  // ── Theme transition state (palette + skin together) ──
  let themeIndex = 0;
  const TRANSITION_DUR = 2.0; // seconds — shared for color + skin
  let colorT = 1;
  let skinT = 1;
  const fromBase = t0.base.clone();
  const fromRim  = t0.rim.clone();
  const fromSpec = t0.spec.clone();
  const toBase   = t0.base.clone();
  const toRim    = t0.rim.clone();
  const toSpec   = t0.spec.clone();

  function smoothstep(t) {
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
  }

  function startTransition(newIndex) {
    fromBase.copy(uniforms.uBaseColor.value);
    fromRim.copy(uniforms.uRimColor.value);
    fromSpec.copy(uniforms.uSpecColor.value);
    const theme = THEMES[newIndex];
    toBase.copy(theme.base);
    toRim.copy(theme.rim);
    toSpec.copy(theme.spec);
    colorT = 0;
    uniforms.uSkinFrom.value = skinT >= 1
      ? uniforms.uSkinTo.value
      : uniforms.uSkinFrom.value;
    uniforms.uSkinTo.value = theme.skin;
    uniforms.uSkinMix.value = 0;
    skinT = 0;
    themeIndex = newIndex;
    // Reset BPM tracker + loudness + snare on track change
    onsetTimes.length = 0;
    detectedBeatMs = 0;
    beatPhaseOrigin = 0;
    bpmConfidence = 0;
    integratedLoudness = 0;
    snareFastAvg = 0;
    snareSlowAvg = 0;
    prevSnareBins.fill(0);
  }

  function nextTheme() {
    startTransition((themeIndex + 1) % THEMES.length);
  }

  function prevTheme() {
    startTransition((themeIndex - 1 + THEMES.length) % THEMES.length);
  }

  // Kick detection — spectral flux + BPM-predictive phase lock
  let kickGlow = 0;
  let kickGlowSlow = 0;
  let kickTriggerTime = -1;
  let kickFastAvg = 0;
  let kickSlowAvg = 0;
  let prevKickBins = new Float32Array(12);
  let lastKickTime = 0;
  const KICK_COOLDOWN = 80;
  const KICK_ABS_FLOOR = 0.0008;
  const KICK_BASE_THRESHOLD = 1.0;

  // ── Snare/clap detection — mid-high frequency spectral flux ──
  let snareFastAvg = 0;
  let snareSlowAvg = 0;
  let prevSnareBins = new Float32Array(30);  // bins ~100-350 (2-8kHz region)
  let lastSnareTime = 0;
  const SNARE_COOLDOWN = 100;
  const SNARE_THRESHOLD = 0.8;

  // ── Integrated loudness normalization ──
  // Tracks long-term average loudness and scales thresholds so quiet/loud
  // tracks trigger kicks at the same perceptual rate
  let integratedLoudness = 0;    // long-term EMA of RMS (very slow)
  let loudnessScale = 1.0;       // updated per frame, shared by kick + snare detection
  const TARGET_LOUDNESS = 0.15;  // reference level — thresholds tuned for this

  // ── BPM tracker ──
  const BPM_MIN = 70;
  const BPM_MAX = 180;
  const BEAT_MS_MIN = 60000 / BPM_MAX;  // ~333ms
  const BEAT_MS_MAX = 60000 / BPM_MIN;  // ~857ms
  const ONSET_HISTORY_SIZE = 16;
  const onsetTimes = [];         // circular buffer of recent kick timestamps
  let detectedBeatMs = 0;        // ms per beat (0 = unknown)
  let beatPhaseOrigin = 0;       // timestamp of phase-lock anchor
  let bpmConfidence = 0;         // 0-1 how confident we are in the BPM

  function updateBPM(triggerTime) {
    onsetTimes.push(triggerTime);
    if (onsetTimes.length > ONSET_HISTORY_SIZE) onsetTimes.shift();
    if (onsetTimes.length < 4) { bpmConfidence = 0; return; }

    // Compute all inter-onset intervals within valid BPM range
    const intervals = [];
    for (let i = 1; i < onsetTimes.length; i++) {
      const ioi = onsetTimes[i] - onsetTimes[i - 1];
      if (ioi >= BEAT_MS_MIN && ioi <= BEAT_MS_MAX) {
        intervals.push(ioi);
      }
      // Also check half-time (every other beat)
      if (i >= 2) {
        const ioi2 = (onsetTimes[i] - onsetTimes[i - 2]) / 2;
        if (ioi2 >= BEAT_MS_MIN && ioi2 <= BEAT_MS_MAX) {
          intervals.push(ioi2);
        }
      }
    }
    if (intervals.length < 3) { bpmConfidence *= 0.9; return; }

    // Cluster intervals: find the mode using a tolerance window (±20ms)
    const CLUSTER_TOL = 20;
    let bestCount = 0;
    let bestMedian = 0;
    for (let i = 0; i < intervals.length; i++) {
      let count = 0;
      let sum = 0;
      for (let j = 0; j < intervals.length; j++) {
        if (Math.abs(intervals[j] - intervals[i]) < CLUSTER_TOL) {
          count++;
          sum += intervals[j];
        }
      }
      if (count > bestCount) {
        bestCount = count;
        bestMedian = sum / count;
      }
    }

    // Confidence: what fraction of intervals agree with the mode
    const agreeing = intervals.filter(v => Math.abs(v - bestMedian) < CLUSTER_TOL).length;
    const newConf = agreeing / intervals.length;

    // Smooth BPM transition — don't jump erratically
    if (detectedBeatMs === 0 || Math.abs(bestMedian - detectedBeatMs) < CLUSTER_TOL) {
      // Refine existing estimate
      detectedBeatMs = detectedBeatMs === 0
        ? bestMedian
        : detectedBeatMs * 0.7 + bestMedian * 0.3;
      bpmConfidence = bpmConfidence * 0.6 + newConf * 0.4;
      beatPhaseOrigin = triggerTime;
    } else if (newConf > bpmConfidence + 0.15) {
      // New BPM is significantly more confident — switch
      detectedBeatMs = bestMedian;
      bpmConfidence = newConf;
      beatPhaseOrigin = triggerTime;
    } else {
      bpmConfidence *= 0.95;
    }
  }

  function getBeatProximity(time) {
    // Returns 0-1: how close `time` is to the nearest predicted beat
    // 1.0 = right on the beat, 0.0 = maximally off-beat
    if (detectedBeatMs === 0 || bpmConfidence < 0.3) return 0.5; // neutral
    const elapsed = time - beatPhaseOrigin;
    const phase = ((elapsed % detectedBeatMs) + detectedBeatMs) % detectedBeatMs;
    // Distance from nearest beat edge (0 or detectedBeatMs)
    const distFromBeat = Math.min(phase, detectedBeatMs - phase);
    // Normalize: 0ms from beat → 1.0, half-beat away → 0.0
    const halfBeat = detectedBeatMs / 2;
    return 1.0 - (distFromBeat / halfBeat);
  }

  // Tick state
  let active = false;
  let lastTime = 0;
  let smoothLevel = 0.55;
  const MIN_SCALE = 0.55;
  let growProgress = 0;       // 0 → 1 over 30 seconds
  let showTime = 0;           // timestamp when show() was called
  const GROW_DURATION = 30;   // seconds

  function tick(time) {
    if (!active) return;

    const dt = lastTime ? (time - lastTime) / 1000 : 0.016;
    lastTime = time;

    readBands();

    // ── Volume gate: compute RMS → masterEnergy / peakEnergy ──
    const analyserRef = getAnalyser();
    let hasAudio = false;
    if (analyserRef) {
      // RMS from frequency data
      let sumSq = 0;
      for (let i = 0; i < freqData.length; i++) {
        const v = freqData[i] / 255;
        sumSq += v * v;
      }
      currentRMS = Math.sqrt(sumSq / freqData.length);
      hasAudio = currentRMS > 0.01;

      // Update integrated loudness (very slow EMA ~5-10 seconds)
      if (hasAudio) {
        integratedLoudness += 0.005 * (currentRMS - integratedLoudness);
      }

      // Power curve: gentle gating — intros still show subtle reactivity
      const gated = Math.pow(currentRMS, 0.6);
      const gatedFloored = hasAudio ? Math.max(gated, 0.25) : gated;
      masterEnergy += 0.08 * (gatedFloored - masterEnergy);  // slow ramp
      peakEnergy += 0.25 * (gatedFloored - peakEnergy);      // fast transient
    } else {
      masterEnergy += 0.08 * (0 - masterEnergy);
      peakEnergy += 0.25 * (0 - peakEnergy);
      currentRMS = 0;
    }

    // ── Energy surge: sustained full spectrum triggers horizontal drift ──
    // Slow-moving average of overall energy — detects sustained loud sections
    const surgeRate = masterEnergy > sustainedEnergy ? 0.04 : 0.02;
    sustainedEnergy += surgeRate * (masterEnergy - sustainedEnergy);

    // When sustained energy exceeds threshold, pick a new drift direction
    if (sustainedEnergy > surgeThreshold && time - lastSurgeTime > 3000) {
      lastSurgeTime = time;
      energySurgeDir = Math.random() > 0.5 ? 1 : -1;
      surgeThreshold = 0.35 + Math.random() * 0.2;

      // TYPE 4: Stardust on energy surge (max every 5s)
      if (time - lastSurgePulseTime > 5000) {
        lastSurgePulseTime = time;
        fireStardust();
      }
    }

    // TYPE 3: Aurora wisps on sustained high frequencies (max every 8s)
    if (analyserRef && time - lastHighPulseTime > 8000) {
      let highSum = 0;
      for (let i = 60; i < 120; i++) highSum += freqData[i];
      const highLevel = highSum / (60 * 255);
      if (highLevel > 0.25 && masterEnergy > 0.2) {
        lastHighPulseTime = time;
        fireSolarFlare();
      }
    }

    // TYPE 5: Plasma bloom — on energy drops AND periodically during sustained energy
    if (sustainedEnergy < 0.15 && masterEnergy < 0.1 && time - lastDropPulseTime > 5000) {
      if (lastSurgeTime > 0 && time - lastSurgeTime < 4000) {
        lastDropPulseTime = time;
        firePlasmaBloom();
      }
    }

    // Smooth drift toward target position
    const targetDrift = sustainedEnergy > 0.3 ? energySurgeDir * sustainedEnergy * 60 : 0;
    energySurgeDrift += (targetDrift - energySurgeDrift) * 0.02; // very smooth

    // ── Kick detection — spectral flux + BPM-predictive gating ──
    if (analyserRef) {
      // Sample bins 0-11 (~0-250Hz), weight lowest bins heaviest (kick fundamentals)
      // Bin weights: bins 0-4 (sub/kick ~0-100Hz) = full, 5-8 (low-mid) = half, 9-11 (upper) = quarter
      const bins = 12;
      let energy = 0;
      let flux = 0;
      for (let i = 0; i < bins; i++) {
        const v = freqData[i] / 255;
        const vSq = v * v;
        const w = i < 5 ? 1.0 : i < 9 ? 0.5 : 0.25;
        energy += vSq;
        const diff = vSq - prevKickBins[i];
        if (diff > 0) flux += diff * w;
        prevKickBins[i] = vSq;
      }
      energy /= bins;

      // Loudness normalization: scale flux relative to integrated loudness
      loudnessScale = integratedLoudness > 0.02
        ? TARGET_LOUDNESS / integratedLoudness
        : 1.0;
      const normFlux = flux * Math.min(loudnessScale, 4.0);  // cap at 4x boost for very quiet tracks

      // Adaptive averages — slow avg tracks slower in loud sections so kicks stand out more
      const slowRate = currentRMS > 0.15 ? 0.02 : 0.035;
      kickSlowAvg += slowRate * (normFlux - kickSlowAvg);
      kickFastAvg += 0.12 * (normFlux - kickFastAvg);

      // Loudness-adaptive threshold:
      // Loud sections (RMS > 0.2): lower threshold (0.75x) — kicks compete with dense mix
      // Quiet sections (RMS < 0.05): higher sensitivity via loudness normalization already
      // Mid levels: interpolate
      const loudAdapt = Math.min(Math.max((currentRMS - 0.05) / 0.2, 0), 1);
      const loudThreshScale = 1.0 - loudAdapt * 0.25;  // 1.0 at quiet → 0.75 at loud

      // BPM-predictive threshold modulation
      const beatProx = getBeatProximity(time);
      const bpmScale = bpmConfidence > 0.3
        ? 0.55 + (1.0 - beatProx) * 0.8
        : 1.0;

      const dynThreshold = KICK_BASE_THRESHOLD * bpmScale * loudThreshScale;
      const aboveSlowThresh = normFlux > kickSlowAvg * dynThreshold + KICK_ABS_FLOOR;
      const aboveFastThresh = normFlux > kickFastAvg * (1.1 + (1.0 - beatProx) * 0.4 * bpmConfidence);
      const cooledDown = time - lastKickTime > KICK_COOLDOWN;

      if (aboveSlowThresh && aboveFastThresh && cooledDown && energy > 0.001) {
        kickTriggerTime = time;
        lastKickTime = time;
        lastKickHeard = time;
        updateBPM(time);

        // Schedule 8-bar pulse on first kick or when BPM is established
        if (!pulseActive && detectedBeatMs > 0 && bpmConfidence > 0.3) {
          pulseActive = true;
          firstKickTime = time;
          // 8 bars = 32 beats
          const eightBarMs = detectedBeatMs * 32;
          nextPulseTime = time; // fire immediately on first detection
        }
      }

      // Fire scheduled pulse
      if (pulseActive && time >= nextPulseTime) {
        const eightBarMs = detectedBeatMs > 0 ? detectedBeatMs * 32 : 8000;
        firePulse();
        pulseCount++;
        nextPulseTime = time + eightBarMs;
      }

      // Stop pulsing if no kick heard for 3 seconds
      if (pulseActive && time - lastKickHeard > 3000) {
        pulseActive = false;
        pulseCount = 0;
      }
    }

    // ── Snare/clap detection — mid-high frequency flux (bins ~100-350, approx 2-8kHz) ──
    if (analyserRef) {
      let snareFlux = 0;
      for (let i = 0; i < 30; i++) {
        const binIdx = 100 + i;  // bins 100-129 (~2-6kHz)
        const v = freqData[binIdx] / 255;
        const vSq = v * v;
        const diff = vSq - prevSnareBins[i];
        if (diff > 0) snareFlux += diff;
        prevSnareBins[i] = vSq;
      }

      // Normalize by loudness like kicks
      const snareNorm = snareFlux * Math.min(loudnessScale, 4.0);
      snareSlowAvg += 0.025 * (snareNorm - snareSlowAvg);
      snareFastAvg += 0.12 * (snareNorm - snareFastAvg);

      const snareCooled = time - lastSnareTime > SNARE_COOLDOWN;
      const aboveSnare = snareNorm > snareSlowAvg * SNARE_THRESHOLD + 0.001;
      const aboveSnareFast = snareNorm > snareFastAvg * 1.25;

      if (aboveSnare && aboveSnareFast && snareCooled && masterEnergy > 0.1) {
        lastSnareTime = time;
        spawnBurst(uniforms.uRimColor.value);
      }
    }

    // Shaped kick glow envelopes — instant attack, exponential decay
    if (kickTriggerTime >= 0) {
      const t = (time - kickTriggerTime) / 1000;  // seconds since trigger
      kickGlow = Math.exp(-t * 8.0) * 0.5;    // faster decay, half intensity
      kickGlowSlow = Math.exp(-t * 3.5) * 0.4;  // gentler lingering warmth
      // Gate by masterEnergy so silent = no glow
      kickGlow *= masterEnergy;
      kickGlowSlow *= masterEnergy;
      // Kill envelope when negligible
      if (kickGlow < 0.001 && kickGlowSlow < 0.001) {
        kickTriggerTime = -1;
        kickGlow = 0;
        kickGlowSlow = 0;
      }
    } else {
      kickGlow = 0;
      kickGlowSlow = 0;
    }
    uniforms.uKickGlow.value = kickGlow;
    uniforms.uKickGlowSlow.value = kickGlowSlow;

    // ── Amoeba tendril morphing — audio-contextual ──
    // Tendril strength driven by: sustained mid+high energy = tendrils extend
    // Morph intensity driven by: bass energy variance = more bizarre shapes
    {
      // Mid-high energy detection (bins 30-80)
      let midHighSum = 0;
      if (analyserRef) {
        for (let i = 30; i < 80; i++) midHighSum += freqData[i];
      }
      const midHighLevel = midHighSum / (50 * 255);

      // Tendril strength — scales with energy, impossible below 0.1, unlikely at low levels
      // Probability curve: quiet = rare brief flickers, loud = sustained extensions
      let targetTendril = 0;
      if (midHighLevel > 0.1) {
        // Scaled likelihood: 0.1-0.2 = subtle, 0.2-0.35 = moderate, 0.35+ = strong
        const energy01 = Math.min((midHighLevel - 0.1) / 0.4, 1); // 0-1 normalized
        targetTendril = energy01 * energy01 * 0.7; // quadratic — gentle at low, strong at high
      }
      const tendrilRate = targetTendril > uniforms.uTendrilStr.value ? 0.015 : 0.005;
      uniforms.uTendrilStr.value += (targetTendril - uniforms.uTendrilStr.value) * tendrilRate;

      // Phase slowly rotates — tendrils sweep around
      uniforms.uTendrilPhase.value += dt * 0.1 * (1 + masterEnergy * 0.5);

      // Morph intensity — scales with energy, needs at least moderate level
      let targetMorph = 0;
      if (masterEnergy > 0.15) {
        const morphEnergy = Math.min((masterEnergy - 0.15) / 0.5, 1);
        targetMorph = morphEnergy * morphEnergy * 0.6 * (0.3 + ema.bass * 0.7);
      }
      const morphRate = targetMorph > uniforms.uMorphIntensity.value ? 0.02 : 0.006;
      uniforms.uMorphIntensity.value += (targetMorph - uniforms.uMorphIntensity.value) * morphRate;
    }

    // Master level → canvas scale
    if (analyserRef) {
      let sum = 0;
      for (let i = 0; i < freqData.length; i++) sum += freqData[i];
      const raw = sum / (freqData.length * 255);
      const rate = raw > smoothLevel ? 0.12 : 0.03;
      smoothLevel += rate * (raw - smoothLevel);
    }
    // Grow from tiny to full over 30 seconds on first show
    if (showTime > 0 && growProgress < 1) {
      growProgress = Math.min(1, (time / 1000 - showTime) / GROW_DURATION);
    }
    const growScale = 0.1 + growProgress * 0.9; // 0.1 → 1.0
    const scale = (MIN_SCALE + smoothLevel * (1.0 - MIN_SCALE)) * growScale;
    const driftX = energySurgeDrift.toFixed(1);
    currentScale = scale;
    currentDriftX = parseFloat(driftX);
    canvas.style.transform = `translate(calc(-50% + ${driftX}px), -50%) scale(${scale.toFixed(4)})`;
    shadowEl.style.transform = `translate(calc(-50% + ${driftX}px), -50%) scale(${(scale * 1.1).toFixed(4)})`;

    // Color palette transition
    if (colorT < 1) {
      colorT = Math.min(1, colorT + dt / TRANSITION_DUR);
      const s = smoothstep(colorT);
      uniforms.uBaseColor.value.lerpColors(fromBase, toBase, s);
      uniforms.uRimColor.value.lerpColors(fromRim, toRim, s);
      uniforms.uSpecColor.value.lerpColors(fromSpec, toSpec, s);
    }

    // Skin transition
    if (skinT < 1) {
      skinT = Math.min(1, skinT + dt / TRANSITION_DUR);
      uniforms.uSkinMix.value = smoothstep(skinT);
    }

    // Send gated frequency bands to shader (multiplied by masterEnergy)
    uniforms.uTime.value = time / 1000;
    uniforms.uBass.value = ema.bass * masterEnergy;
    uniforms.uMid.value  = ema.mid  * masterEnergy;
    uniforms.uHigh.value = ema.high * masterEnergy;
    uniforms.uMasterEnergy.value = masterEnergy;
    uniforms.uPeakEnergy.value = peakEnergy;
    renderer.render(scene, camera);

    // Render particles on top (additive blend, no clear)
    const hasParticles = tickParticles(dt);
    if (hasParticles) {
      renderer.autoClear = false;
      renderer.render(particleScene, particleCam);
      renderer.autoClear = true;
    }

    // Clear pulse canvas, then draw wanderers + pulses
    pulseCtx.clearRect(0, 0, PULSE_W, PULSE_H);
    tickWanderers(time);
    if (activePulses.length) tickPulses();
  }

  function show() {
    active = true;
    canvas.style.opacity = '1';
    shadowEl.style.opacity = '1';
    if (showTime === 0) showTime = performance.now() / 1000;
  }

  function hide() {
    active = false;
    canvas.style.opacity = '0';
    shadowEl.style.opacity = '0';
  }

  // Expose glob screen bounds for collision detection
  let currentScale = 0;
  let currentDriftX = 0;
  function getGlobBounds() {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // Approximate visible glob radius (canvas is square, glob fills ~60% of it)
    const radius = (rect.width * 0.3) * currentScale;
    return { cx, cy, radius };
  }

  return { tick, show, hide, canvas, nextTheme, prevTheme, getGlobBounds, get active() { return active; } };
}
