/** Morphics Audio Player
 *  - Fetches tracks.json, shuffles with Fisher-Yates
 *  - Web Audio API waveform visualization via AnalyserNode
 *  - AudioContext created on first user gesture (browser autoplay policy)
 */

let tracks = [];
let currentIndex = 0;
let audio = null;
let audioCtx = null;
let analyser = null;
let source = null;
let analyserL = null;
let analyserR = null;
let splitter = null;
let animationId = null;
let isPlaying = false;

// DOM references (set in init)
let titleEl, titleAltEl, playBtn, prevBtn, nextBtn, canvas, ctx;
let isMorphing = false;
let morphFadeOutTimer = null;
let morphFadeInTimer = null;

// Cached letter elements — updated whenever wrapLetters is called
let cachedLetters = [];
let cachedAltLetters = []; // letters on titleAltEl during transitions
const startTime = performance.now();

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let isFirstReveal = true;

// Wrap text into individual letter spans
// fadeIn: true = letters start invisible and fade in with random timing
function wrapLetters(el, text, fadeIn = false) {
  el.innerHTML = '';
  el.setAttribute('data-text', text);
  const spans = [];
  for (let ci = 0; ci < text.length; ci++) {
    const ch = text[ci];
    const span = document.createElement('span');
    span.classList.add('title-letter');
    span.textContent = ch === ' ' ? '\u00A0' : ch;
    // Random z-index so overlapping letters stack naturally
    span.style.zIndex = Math.floor(Math.random() * text.length);
    span.style.position = 'relative';
    if (fadeIn) {
      span.style.opacity = '0';
    }
    el.appendChild(span);
    spans.push(span);
  }
  // Re-cache and immediately apply wave positions
  if (el === titleEl) {
    cachedLetters = spans;
    applyWaveToLetters(cachedLetters, performance.now());
  } else if (el === titleAltEl) {
    cachedAltLetters = spans;
    applyWaveToLetters(cachedAltLetters, performance.now());
  }
  // Trigger per-letter fade-in after a frame so the browser registers opacity:0 first
  if (fadeIn) {
    const slow = isFirstReveal;
    if (isFirstReveal) isFirstReveal = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (let i = 0; i < spans.length; i++) {
          const dur = slow ? (4.5 + Math.random() * 3.0) : (0.8 + Math.random() * 0.6);
          const del = slow ? (1.0 + Math.random() * 2.5) : (0.1 + Math.random() * 0.35);
          spans[i].style.transition = `opacity ${dur}s ease ${del}s`;
          spans[i].style.opacity = '1';
        }
      });
    });
  }
}

// Apply wave transforms to a set of letters at a given time
function applyWaveToLetters(letters, time) {
  if (!letters.length) return;
  const t = (time - startTime) / 1000;
  for (let i = 0; i < letters.length && i < MAX; i++) {
    const seed = letterSeeds[i];
    const wave1 = Math.sin(t * 0.8 + i * 0.6) * 1.2;
    const wave2 = Math.sin(t * 0.5 + i * 0.9 + 2.0) * 0.7;
    const driftX = Math.sin(t * seed.sx + seed.px) * seed.ax;
    const driftY = Math.sin(t * seed.sy + seed.py) * seed.ay;
    const driftR = Math.sin(t * seed.sr + seed.pr) * seed.ar;
    const x = driftX;
    const y = wave1 + wave2 + driftY;
    const breathe = Math.sin(t * seed.breatheSpeed + seed.breathePhase) * seed.breatheAmp;
    const scale = 1 + breathe;
    letters[i].style.transform = `translate(${x}px, ${y}px) scale(${scale}) rotate(${driftR}deg)`;
    // Set initial color/opacity to match the tick loop's resting state — prevents bright flash
    letters[i].style.color = 'rgba(220, 210, 195, 0.82)';
    letters[i].style.textShadow = '0 0 6px rgba(0,0,0,0.4), 0 0 20px rgba(0,0,0,0.15)';
  }
}

// All letter animation state — unified in one rAF loop, no CSS transitions
let isHovering = false;

// Letter hover/wave state
const MAX = 30;
const letterState = [];
const letterSeeds = [];
for (let i = 0; i < MAX; i++) {
  letterState.push({
    hoverTargetScale: 0, hoverTargetY: 0, hoverTargetGlow: 0,
    hoverScale: 0, hoverY: 0, hoverGlow: 0,
    bounceVelY: 0, bounceY: 0,
    bounceVelS: 0, bounceS: 0,
  });
  letterSeeds.push({
    px: Math.random() * Math.PI * 2,
    py: Math.random() * Math.PI * 2,
    pr: Math.random() * Math.PI * 2,
    sx: 0.5 + Math.random() * 0.6,
    sy: 0.45 + Math.random() * 0.5,
    sr: 0.3 + Math.random() * 0.4,
    ax: 0.9 + Math.random() * 1.1,
    ay: 0.6 + Math.random() * 0.9,
    ar: 2 + Math.random() ** 2 * 10,
    // Per-letter breathing
    breatheSpeed: 0.15 + Math.random() * 0.25,
    breathePhase: Math.random() * Math.PI * 2,
    breatheAmp: 0.025 + Math.random() * 0.035,
  });
}

// Mousemove: store cursor position, compute hover in the rAF loop instead
let cursorX = 0, cursorY = 0, cursorActive = false;
let bulkHoverTarget = 0, bulkHover = 0;

function initLetterHover() {
  const wrap = titleEl?.parentElement;
  if (!wrap) return;

  wrap.addEventListener('mouseenter', () => {
    isHovering = true;
    cursorActive = true;
    bulkHoverTarget = 1;
  });

  wrap.addEventListener('mousemove', (e) => {
    isHovering = true;
    cursorActive = true;
    cursorX = e.clientX;
    cursorY = e.clientY;
  });

  wrap.addEventListener('mouseleave', (e) => {
    isHovering = false;
    cursorActive = false;

    bulkHoverTarget = 0;

    // Zero out hover targets so they lerp back smoothly
    for (let i = 0; i < MAX; i++) {
      letterState[i].hoverTargetScale = 0;
      letterState[i].hoverTargetY = 0;
      letterState[i].hoverTargetGlow = 0;
    }

    // Trigger bounce on nearby letters — use cached positions
    const letters = cachedLetters;
    if (!letters.length) return;

    // Use offsetLeft for position (no forced layout)
    let closestIdx = 0;
    let closestDist = Infinity;
    for (let i = 0; i < letters.length; i++) {
      const cx = letters[i].offsetLeft + letters[i].offsetWidth / 2;
      const d = Math.abs(e.clientX - wrap.getBoundingClientRect().left - cx);
      if (d < closestDist) { closestDist = d; closestIdx = i; }
    }

    const radius = 2 + Math.floor(Math.random() * 3); // 2-4 letters affected
    for (let i = 0; i < letters.length && i < MAX; i++) {
      const indexDist = Math.abs(i - closestIdx);
      if (indexDist > radius) continue;
      const strength = 1 - indexDist / (radius + 1);
      const randY = 0.15 + Math.random() * 0.25;      // 0.15-0.4 impulse range
      const randS = 0.001 + Math.random() * 0.002;    // varied scale squish
      const direction = Math.random() > 0.3 ? -1 : 1; // mostly up, sometimes down
      letterState[i].bounceVelY = direction * randY * strength;
      letterState[i].bounceVelS = randS * strength;
    }
  });
}

// Single master animation tick — called from index.astro's unified loop
// (startTime declared at top of module)
const lerpSpeed = 0.45;
const springStiff = 0.08;
const springDamp = 0.88;

// Audio glow state
const glowFreqData = new Uint8Array(256);
let audioGlow = 0;
let audioGlowMid = 0;
let audioEnergy = 0;  // smoothed overall energy 0-1, drives movement intensity

export function tickLetters(time) {
  const letters = cachedLetters;
  if (!letters.length) return;

  // Sample audio for reactive glow
  if (analyser) {
    analyser.getByteFrequencyData(glowFreqData);
    // Bass: bins 2-8, Mid: bins 10-30
    let bassSum = 0, midSum = 0;
    for (let b = 2; b < 8; b++) bassSum += glowFreqData[b];
    for (let b = 10; b < 30; b++) midSum += glowFreqData[b];
    const bassNorm = bassSum / (6 * 255);
    const midNorm = midSum / (20 * 255);
    // Smooth with fast attack, slow release
    const bassRate = bassNorm > audioGlow ? 0.3 : 0.05;
    const midRate = midNorm > audioGlowMid ? 0.25 : 0.04;
    audioGlow += (bassNorm - audioGlow) * bassRate;
    audioGlowMid += (midNorm - audioGlowMid) * midRate;
    // Overall energy — average across full spectrum, very smooth
    let totalSum = 0;
    for (let b = 0; b < 128; b++) totalSum += glowFreqData[b];
    const rawEnergy = totalSum / (128 * 255);
    const energyRate = rawEnergy > audioEnergy ? 0.08 : 0.015;
    audioEnergy += (rawEnergy - audioEnergy) * energyRate;
  }

  // Smooth bulk hover scale for all letters
  // Quick onset, very slow smooth fade out
  const bulkLerp = bulkHoverTarget > bulkHover ? 0.3 : 0.06;
  bulkHover += (bulkHoverTarget - bulkHover) * bulkLerp;

  const t = (time - startTime) / 1000;

  // Compute hover targets from cursor position (replaces per-letter getBoundingClientRect)
  if (cursorActive && isHovering) {
    const wrap = titleEl?.parentElement;
    if (wrap) {
      const wrapRect = wrap.getBoundingClientRect();
      for (let i = 0; i < letters.length && i < MAX; i++) {
        const letter = letters[i];
        const cx = wrapRect.left + letter.offsetLeft + letter.offsetWidth / 2;
        const cy = wrapRect.top + letter.offsetTop + letter.offsetHeight / 2;
        const dist = Math.sqrt((cursorX - cx) ** 2 + (cursorY - cy) ** 2);
        const proximity = Math.max(0, 1 - dist / 100);
        letterState[i].hoverTargetScale = 0.042 * proximity;
        letterState[i].hoverTargetY = -0.6 * proximity;
        letterState[i].hoverTargetGlow = proximity;
      }
    }
  }

  for (let i = 0; i < letters.length && i < MAX; i++) {
    const s = letterState[i];
    const seed = letterSeeds[i];

    // Lerp hover
    s.hoverScale += (s.hoverTargetScale - s.hoverScale) * lerpSpeed;
    s.hoverY += (s.hoverTargetY - s.hoverY) * lerpSpeed;
    s.hoverGlow += (s.hoverTargetGlow - s.hoverGlow) * lerpSpeed;

    // Spring bounce
    s.bounceVelY += -springStiff * s.bounceY;
    s.bounceVelY *= springDamp;
    s.bounceY += s.bounceVelY;
    s.bounceVelS += -springStiff * s.bounceS;
    s.bounceVelS *= springDamp;
    s.bounceS += s.bounceVelS;

    if (Math.abs(s.bounceY) < 0.001 && Math.abs(s.bounceVelY) < 0.001) {
      s.bounceY = 0; s.bounceVelY = 0;
    }
    if (Math.abs(s.bounceS) < 0.0001 && Math.abs(s.bounceVelS) < 0.0001) {
      s.bounceS = 0; s.bounceVelS = 0;
    }

    // Movement intensity scales with audio energy — 0.3 at silence, 1.0 at full
    const intensity = 0.3 + audioEnergy * 2.5; // caps naturally since audioEnergy rarely exceeds ~0.3

    // Ambient wave — scaled by audio intensity
    const wave1 = Math.sin(t * 0.8 + i * 0.6) * 1.6 * intensity;
    const wave2 = Math.sin(t * 0.5 + i * 0.9 + 2.0) * 1.0 * intensity;
    const driftX = Math.sin(t * seed.sx + seed.px) * seed.ax * intensity;
    const driftY = Math.sin(t * seed.sy + seed.py) * seed.ay * intensity;
    const driftR = Math.sin(t * seed.sr + seed.pr) * seed.ar; // rotation NOT scaled

    // Combine
    const x = driftX;
    const y = wave1 + wave2 + driftY + s.bounceY;
    const breathe = Math.sin(t * seed.breatheSpeed + seed.breathePhase) * seed.breatheAmp * intensity;
    const scale = 1 + breathe + s.bounceS;

    const el = letters[i];

    // Audio-reactive effects per letter (no hover)
    const letterPhase = Math.sin(t * 0.5 + i * 0.8) * 0.5 + 0.5;
    const audioG = audioGlow * (0.4 + letterPhase * 0.3) * 0.5 + audioGlowMid * 0.15;

    // Audio-reactive letter distortion
    const bassWarp = audioGlow * seed.breatheAmp * 8;
    const midStretch = audioGlowMid * 0.06;
    const skewAudio = Math.sin(t * 1.2 + i * 1.5) * audioGlow * 3;
    const scaleX = 1 + breathe + midStretch * (Math.sin(t * 0.7 + i) * 0.5 + 0.5);
    const scaleY = 1 + breathe - bassWarp * 0.3 * letterPhase;

    const globWarp = el.dataset.globWarp || '';
    el.style.transform = `translate(${x}px, ${(y + bassWarp * 2 * (letterPhase - 0.5)).toFixed(2)}px) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)}) rotate(${(driftR + skewAudio).toFixed(2)}deg) ${globWarp}`;

    // Brighter base color — no hover influence
    const hueShift = audioGlow * 8 * Math.sin(t * 0.3 + i * 0.9);
    const warmth = 220 + audioG * 30 + audioGlow * 15;
    const c = Math.round(Math.min(255, warmth));
    const a = (0.82 + audioG * 0.1).toFixed(3);
    const glowRadius = (4 + audioG * 12).toFixed(1);
    const glowOpacity = (audioG * 0.18).toFixed(4);

    // Audio-reactive blur
    const audioBlur = audioGlow * 0.8 * letterPhase;

    el.style.color = `rgba(${c}, ${Math.max(0, c - 10 - Math.round(hueShift))}, ${Math.max(0, c - 25 + Math.round(hueShift * 0.5))}, ${a})`;
    el.style.textShadow = `0 0 6px rgba(0,0,0,0.4), 0 0 20px rgba(0,0,0,0.15), 0 0 ${glowRadius}px rgba(255,255,255,${glowOpacity})`;
    el.style.filter = audioBlur > 0.05 ? `blur(${audioBlur.toFixed(2)}px)` : '';
  }

  // Also animate alt letters during transitions
  if (cachedAltLetters.length) {
    applyWaveToLetters(cachedAltLetters, time);
  }
}

function updateTitle() {
  if (!titleEl || !tracks[currentIndex]) return;

  // First load — fade in per-letter
  if (!titleAltEl || !titleEl.textContent || titleEl.textContent === 'MORPHICS') {
    wrapLetters(titleEl, tracks[currentIndex].title, true);
    return;
  }

  // Cancel any in-progress morph so rapid skips always show the correct title
  if (isMorphing) {
    clearTimeout(morphFadeOutTimer);
    clearTimeout(morphFadeInTimer);
    titleEl.classList.remove('is-morphing');
    cachedAltLetters = [];
    titleAltEl.innerHTML = '';
    titleAltEl.style.opacity = '';
    isMorphing = false;
  }

  isMorphing = true;
  const newTitle = tracks[currentIndex].title;

  // Step 1: kill breathe animation
  titleEl.classList.add('is-morphing');

  // Step 2: per-letter fade out with random timing
  const oldLetters = cachedLetters;
  for (let i = 0; i < oldLetters.length; i++) {
    const dur = 0.5 + Math.random() * 0.4; // 0.5–0.9s
    const del = 0.03 + Math.random() * 0.2; // 0.03–0.23s
    oldLetters[i].style.transition = `opacity ${dur}s ease ${del}s`;
    oldLetters[i].style.opacity = '0';
  }

  // Step 3: after fade-out completes, fade in new text per-letter
  morphFadeOutTimer = setTimeout(() => {
    // Guard: if another morph cancelled us, bail
    if (tracks[currentIndex].title !== newTitle) return;

    titleAltEl.style.opacity = '0.88';
    wrapLetters(titleAltEl, newTitle, true);

    morphFadeInTimer = setTimeout(() => {
      if (tracks[currentIndex].title !== newTitle) return;

      wrapLetters(titleEl, newTitle, false);
      titleEl.classList.remove('is-morphing');
      cachedAltLetters = [];
      titleAltEl.innerHTML = '';
      titleAltEl.style.opacity = '';
      isMorphing = false;
    }, 1600);
  }, 1000);
}

function updatePlayButton() {
  if (playBtn) {
    playBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    const pi = playBtn._playIcon || playBtn.querySelector('.play-icon');
    const pa = playBtn._pauseIcon || playBtn.querySelector('.pause-icon');
    if (pi) pi.style.display = isPlaying ? 'none' : 'block';
    if (pa) pa.style.display = isPlaying ? 'block' : 'none';
  }
}

// Blob track pulse — shrink then slowly grow back
let blobTrackScale = 1;
let blobTrackTarget = 1;
function pulseBlob() {
  blobTrackScale = 0.93;
  blobTrackTarget = 1;
}
export function tickBlobPulse() {
  // Slow lerp back to 1
  blobTrackScale += 0.003 * (blobTrackTarget - blobTrackScale);
  return blobTrackScale;
}

function loadTrack(index) {
  if (!audio || !tracks[index]) return;
  const isFirst = currentIndex === 0 && !audio.src;
  currentIndex = index;
  audio.src = tracks[index].url;
  updateTitle();
  if (!isFirst) pulseBlob();
}

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source = audioCtx.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioCtx.destination);

    // Stereo split for L/R analysis
    splitter = audioCtx.createChannelSplitter(2);
    analyserL = audioCtx.createAnalyser();
    analyserR = audioCtx.createAnalyser();
    analyserL.fftSize = 1024;
    analyserR.fftSize = 1024;
    source.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

async function play() {
  if (!audio || !tracks.length) return;
  ensureAudioContext();
  if (canvas) resizeCanvas();
  try {
    await audio.play();
    isPlaying = true;
    updatePlayButton();
    if (canvas) drawWaveform();
  } catch (e) {
    console.warn('Playback failed:', e);
  }
}

function pause() {
  if (!audio) return;
  audio.pause();
  isPlaying = false;
  updatePlayButton();
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
}

function togglePlay() {
  if (isPlaying) {
    pause();
  } else {
    play();
  }
}

function next() {
  const nextIndex = (currentIndex + 1) % tracks.length;
  loadTrack(nextIndex);
  if (isPlaying) play();
}

function prev() {
  const prevIndex = (currentIndex - 1 + tracks.length) % tracks.length;
  loadTrack(prevIndex);
  if (isPlaying) play();
}

let waveformBuffer = null;
function drawWaveform() {
  if (!analyser || !canvas || !ctx) return;
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  const bufferLength = analyser.frequencyBinCount;
  if (!waveformBuffer || waveformBuffer.length !== bufferLength) {
    waveformBuffer = new Uint8Array(bufferLength);
  }
  const dataArray = waveformBuffer;

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width;
  const height = canvas.height;
  const cssHeight = height / dpr;
  const primaryY = cssHeight * 0.4;
  const reflectY = cssHeight * 0.6;
  const amplitude = cssHeight * 0.25;
  const sliceWidth = (width / dpr) / bufferLength;

  // Pre-compute gradient once
  const grad = ctx.createLinearGradient(0, primaryY, 0, reflectY);
  grad.addColorStop(0, 'rgba(0, 204, 168, 0.08)');
  grad.addColorStop(0.5, 'rgba(0, 204, 168, 0.03)');
  grad.addColorStop(1, 'rgba(0, 204, 168, 0)');

  function draw() {
    animationId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(dataArray);

    ctx.clearRect(0, 0, width, height);

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

    ctx.fillStyle = grad;
    ctx.fillRect(0, primaryY, width / dpr, reflectY - primaryY);
  }

  draw();
}

function resizeCanvas() {
  if (!canvas) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
}

export async function init() {
  titleEl = document.getElementById('player-title');
  titleAltEl = document.getElementById('player-title-alt');
  playBtn = document.getElementById('player-play');
  prevBtn = document.getElementById('player-prev');
  nextBtn = document.getElementById('player-next');
  if (!titleEl || !playBtn) {
    console.warn('Player elements not found');
    return;
  }
  // Cache icon elements to avoid querySelector per play/pause toggle
  const playIconEl = playBtn.querySelector('.play-icon');
  const pauseIconEl = playBtn.querySelector('.pause-icon');
  if (playIconEl && pauseIconEl) {
    playBtn._playIcon = playIconEl;
    playBtn._pauseIcon = pauseIconEl;
  }

  canvas = document.getElementById('player-waveform');
  if (canvas) ctx = canvas.getContext('2d');

  audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.preload = 'metadata';

  try {
    const res = await fetch('/content/tracks.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    tracks = shuffle(data);
  } catch (e) {
    console.error('Failed to load tracks:', e);
    titleEl.textContent = 'NO SIGNAL';
    return;
  }

  if (!tracks.length) {
    titleEl.textContent = 'NO SIGNAL';
    return;
  }

  wrapLetters(titleEl, 'MORPHICS');
  loadTrack(0);
  initLetterHover();

  // Intro: first click expands controls, then normal play/pause
  const controlsEl = document.querySelector('.player-controls');
  let introPlayed = false;

  playBtn.addEventListener('click', () => {
    if (!introPlayed && controlsEl) {
      introPlayed = true;

      // Get play button center for animation origin
      const btnRect = playBtn.getBoundingClientRect();
      const cx = btnRect.left + btnRect.width / 2;
      const cy = btnRect.top + btnRect.height / 2;

      // Phase 1: Bubble pop — squeeze then burst (while still in intro mode)
      const popRect = playBtn.getBoundingClientRect();
      const pcx = popRect.left + popRect.width / 2;
      const pcy = popRect.top + popRect.height / 2;

      const popAnim = playBtn.animate([
        { transform: 'scale(1)', opacity: 1 },
        { transform: 'scale(0.85)', opacity: 1, offset: 0.2 },
        { transform: 'scale(1.15)', opacity: 0.8, offset: 0.4 },
        { transform: 'scale(1.4)', opacity: 0, offset: 0.7 },
        { transform: 'scale(1.4)', opacity: 0, offset: 1.0 },
      ], { duration: 500, easing: 'ease-out', fill: 'forwards' });

      // Spawn 12 particles
      const particleCount = 12;
      const particleContainer = document.createElement('div');
      particleContainer.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999;';
      document.body.appendChild(particleContainer);

      for (let p = 0; p < particleCount; p++) {
        const angle = (p / particleCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
        const dist = 150 + Math.random() * 200;
        const size = 3 + Math.random() * 7;
        const particle = document.createElement('div');
        particle.style.cssText = `
          position:absolute;
          left:${pcx}px;top:${pcy}px;
          width:${size}px;height:${size}px;
          border-radius:50%;
          background:rgba(235,230,222,0.9);
          box-shadow:0 0 10px rgba(255,255,255,0.5);
          transform:translate(-50%,-50%) scale(1);
          pointer-events:none;
        `;
        particleContainer.appendChild(particle);

        const tx = Math.cos(angle) * dist;
        const ty = Math.sin(angle) * dist;
        const dur = 1200 + Math.random() * 800;

        particle.animate([
          { transform: 'translate(-50%,-50%) scale(1)', opacity: 0.9, offset: 0 },
          { transform: `translate(calc(-50% + ${tx * 0.4}px), calc(-50% + ${ty * 0.4}px)) scale(0.8)`, opacity: 0.7, offset: 0.3 },
          { transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(0.1)`, opacity: 0, offset: 1.0 },
        ], { duration: dur, easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)', fill: 'forwards' });
      }

      setTimeout(() => particleContainer.remove(), 2200);

      // Phase 2: After pop, switch to player mode with all buttons hidden, then fade in
      setTimeout(() => {
        // Get all controls BEFORE switching layout
        const targets = controlsEl.querySelectorAll(':scope > .ctrl-btn, :scope > .volume-wrap');

        // Hide everything with opacity FIRST
        targets.forEach(t => {
          t.style.opacity = '0';
          t.style.animation = 'none'; // kill CSS morph animations during fade
        });
        playBtn.style.opacity = '0';
        playBtn.style.animation = 'none';

        // NOW switch layout — buttons are invisible so no flash
        popAnim.cancel();
        controlsEl.classList.remove('is-intro');
        playBtn.classList.remove('intro-rising', 'intro-hovering', 'leave-ripple', 'is-popped');

        // Force layout recalc so buttons are in final positions
        controlsEl.offsetHeight;

        // Fade in all controls in place — no movement, just opacity
        requestAnimationFrame(() => {
          const allBtns = [...targets, playBtn];
          allBtns.forEach(t => {
            t.style.transition = 'opacity 2.5s ease';
            t.style.opacity = '1';
          });

          // Clean up inline styles and enable drift after fade completes
          setTimeout(() => {
            allBtns.forEach(t => {
              t.style.transition = '';
              t.style.opacity = '';
              t.style.animation = '';
            });
            if (window.__enableBtnDrift) window.__enableBtnDrift();
          }, 2800);
        });
      }, 800);

      // Merge dot array into blob
      const landing = document.querySelector('.landing');
      if (landing) {
        const dots = landing.querySelectorAll('.frag-dot');
        const fragContainer = landing.querySelector('.frag-container');
        const count = dots.length;
        const center = Math.floor(count / 2);

        if (window.__dotsMerging !== undefined) window.__dotsMerging = true;

        // Hide dots immediately
        for (let i = 0; i < count; i++) {
          dots[i].style.transition = 'opacity 0.2s ease';
          dots[i].style.opacity = '0';
        }

        // Start metaball behind the frag container so it's ready
        if (window.__onIntroExit) window.__onIntroExit();

        // After pop, smoothly fade out the black overlay
        setTimeout(() => {
          if (fragContainer) {
            fragContainer.style.filter = 'none';
            fragContainer.style.transition = 'opacity 2.5s ease';
            fragContainer.style.opacity = '0';
          }
          landing.classList.remove('is-intro-mode');
        }, 600);

        // Remove frag container after fade completes
        setTimeout(() => {
          if (fragContainer) fragContainer.style.display = 'none';
        }, 3500);

      }
    }
    togglePlay();
  });

  // Intro hover: smooth rise on enter, ripple burst on leave
  playBtn.addEventListener('mouseenter', () => {
    if (!controlsEl?.classList.contains('is-intro')) return;
    playBtn.classList.remove('leave-ripple');
    playBtn.classList.remove('intro-hovering');
    playBtn.classList.add('intro-rising');
    const onRise = (e) => {
      if (e.animationName !== 'intro-rise') return;
      playBtn.removeEventListener('animationend', onRise);
      playBtn.classList.remove('intro-rising');
      playBtn.classList.add('intro-hovering');
    };
    playBtn.addEventListener('animationend', onRise);
  });

  playBtn.addEventListener('mouseleave', () => {
    if (!controlsEl?.classList.contains('is-intro')) return;
    playBtn.classList.remove('intro-rising');
    playBtn.classList.remove('intro-hovering');
    playBtn.classList.add('leave-ripple');
    const onEnd = (e) => {
      if (e.animationName !== 'leave-burst') return;
      playBtn.removeEventListener('animationend', onEnd);
      playBtn.classList.remove('leave-ripple');
      // Force-restart the continuous pulse from the beginning
      playBtn.style.animation = 'none';
      playBtn.offsetHeight; // trigger reflow
      playBtn.style.animation = '';
    };
    playBtn.addEventListener('animationend', onEnd);
  });

  // Intro: play button itself morphs shape toward cursor via polygon clip-path
  let introMouseX = window.innerWidth / 2;
  let introMouseY = window.innerHeight / 2;
  let smoothAngle = 0;
  let smoothReach = 0;

  // Make button large enough to contain the extension — actual visible shape controlled by clip-path
  const introBaseSize = 150; // CSS size of intro .ctrl-play

  // Ripple container — separate from button so clip-path doesn't hide them
  const rippleContainer = document.createElement('div');
  rippleContainer.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 9996;
    display: none;
  `;
  // Create 5 ripple rings
  for (let r = 0; r < 5; r++) {
    const ring = document.createElement('div');
    ring.className = 'intro-ripple-ring';
    ring.style.cssText = `
      position: absolute;
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.2);
      transform: translate(-50%, -50%) scale(1);
      opacity: 0;
      left: 50%; top: 50%;
    `;
    rippleContainer.appendChild(ring);
  }
  document.body.appendChild(rippleContainer);

  let hoverBurstRunning = false;
  let lastBurstTime = 0;

  document.addEventListener('mousemove', (e) => {
    introMouseX = e.clientX;
    introMouseY = e.clientY;
  });

  function tickIntroReach() {
    if (!controlsEl?.classList.contains('is-intro')) {
      playBtn.style.clipPath = '';
      playBtn.style.width = '';
      playBtn.style.height = '';
      playBtn.style.margin = '';
      requestAnimationFrame(tickIntroReach);
      return;
    }

    const btnRect = playBtn.getBoundingClientRect();
    const btnCx = btnRect.left + btnRect.width / 2;
    const btnCy = btnRect.top + btnRect.height / 2;

    const dx = introMouseX - btnCx;
    const dy = introMouseY - btnCy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const targetAngle = Math.atan2(dy, dx);

    // Inverted reach: extends when cursor is far, retracts when close
    const isHoveringBtn = dist < 80;
    let targetReach = 0;
    if (dist > 80 && dist < 700) {
      targetReach = Math.min((dist - 80) / 500, 1) * 0.8;
    }

    // Smooth interpolation — fast tracking, continuous rotation (no wrapping jumps)
    let angleDiff = targetAngle - smoothAngle;
    // Always take the shortest path around the circle
    angleDiff = ((angleDiff % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    smoothAngle += angleDiff * 0.18;
    smoothReach += (targetReach - smoothReach) * 0.15;

    // Make the button element larger to have room for the bulge
    const maxExtend = introBaseSize * 0.9; // max extra reach in px
    const totalSize = introBaseSize + maxExtend * 2;
    const halfSize = totalSize / 2;
    const baseR = introBaseSize / 2; // circle radius in the larger element
    const peakDist = smoothReach * baseR * 1.8;
    // Bulge width narrows as reach increases — very thin tip when far
    const bulgeWidth = 1.0 - smoothReach * 0.65; // 1.0 at no reach → 0.48 at max reach

    // Normalize smoothAngle to 0..2PI for consistent diff calculation
    const normAngle = ((smoothAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

    const now = performance.now() / 1000;
    const steps = 128;
    let points = [];
    for (let i = 0; i < steps; i++) {
      const theta = (i / steps) * Math.PI * 2;

      let r = baseR;

      // Hover wobble — subtle organic flowing (size independent of wobble now)
      if (isHoveringBtn) {
        r += Math.sin(theta * 3 + now * 1.0) * baseR * 0.035;
        r += Math.sin(theta * 5 - now * 0.7) * baseR * 0.018;
        r += Math.sin(theta * 2 + now * 0.4) * baseR * 0.025;
      }

      // Reach bulge — only when not hovering
      if (!isHoveringBtn) {
        let diff = theta - normAngle;
        if (diff > Math.PI) diff -= Math.PI * 2;
        if (diff < -Math.PI) diff += Math.PI * 2;
        const absDiff = Math.abs(diff);

        if (absDiff < bulgeWidth) {
          const t = 1 - absDiff / bulgeWidth;
          const sineT = Math.sin(t * Math.PI / 2);
          r += peakDist * sineT * sineT * sineT;
        }
      }

      const px = ((halfSize + Math.cos(theta) * r) / totalSize * 100).toFixed(2);
      const py = ((halfSize + Math.sin(theta) * r) / totalSize * 100).toFixed(2);
      points.push(`${px}% ${py}%`);
    }

    playBtn.style.width = totalSize + 'px';
    playBtn.style.height = totalSize + 'px';
    playBtn.style.margin = `-${maxExtend}px`;
    playBtn.style.clipPath = `polygon(${points.join(',')})`;

    // Smoothed proximity for size/color — prevents jumpy transitions
    const rawProximity = Math.max(0, 1 - dist / 700);
    if (typeof tickIntroReach._smoothProx === 'undefined') tickIntroReach._smoothProx = rawProximity;
    tickIntroReach._smoothProx += (rawProximity - tickIntroReach._smoothProx) * 0.08;
    const proximity = tickIntroReach._smoothProx;

    // Distance-based size
    const sizeScale = 0.75 + proximity * 0.35;
    playBtn.style.transform = `scale(${sizeScale.toFixed(4)})`;


    // Position ripple container centered on button
    const rippleSize = 400;
    rippleContainer.style.left = (btnCx - rippleSize / 2) + 'px';
    rippleContainer.style.top = (btnCy - rippleSize / 2) + 'px';
    rippleContainer.style.width = rippleSize + 'px';
    rippleContainer.style.height = rippleSize + 'px';

    // Pure white at varying opacity — no grey tones, no hue
    if (isHoveringBtn) {
      playBtn.style.background = 'rgba(255, 255, 255, 0.22)';
      playBtn.style.filter = 'drop-shadow(0 0 12px rgba(255,255,255,0.2)) drop-shadow(0 0 30px rgba(255,255,255,0.08))';

      // Spawn burst rings occasionally while hovering
      hoverBurstRunning = true;
      const now = performance.now();
      if (now - lastBurstTime > 600 + Math.random() * 800) {
        lastBurstTime = now;
        // Spawn 3-5 rings as a burst
        const burstCount = 3 + Math.floor(Math.random() * 3);
        for (let b = 0; b < burstCount; b++) {
          const delay = b * 120;
          setTimeout(() => {
            const ring = document.createElement('div');
            const size = Math.max(window.innerWidth, window.innerHeight) * 2.5;
            const thickness = 6 + Math.random() * 6; // 6-12px thick
            ring.style.cssText = `
              position: fixed;
              left: ${btnCx}px; top: ${btnCy}px;
              width: ${size}px; height: ${size}px;
              margin-left: ${-size/2}px; margin-top: ${-size/2}px;
              border-radius: 50%;
              border: ${thickness}px solid rgba(255,255,255,0.5);
              box-shadow: 0 0 20px rgba(255,255,255,0.2), inset 0 0 15px rgba(255,255,255,0.1);
              pointer-events: none;
              z-index: 99999;
              transform: scale(0);
              opacity: 1;
            `;
            document.body.appendChild(ring);

            ring.animate([
              { transform: 'scale(0)', opacity: 0.8, borderWidth: thickness + 'px' },
              { transform: 'scale(0.08)', opacity: 0.6, borderWidth: (thickness * 0.8) + 'px', offset: 0.1 },
              { transform: 'scale(0.25)', opacity: 0.35, borderWidth: (thickness * 0.5) + 'px', offset: 0.3 },
              { transform: 'scale(0.5)', opacity: 0.15, borderWidth: (thickness * 0.3) + 'px', offset: 0.55 },
              { transform: 'scale(0.8)', opacity: 0.05, borderWidth: '1px', offset: 0.8 },
              { transform: 'scale(1)', opacity: 0, borderWidth: '0.5px' },
            ], { duration: 2800 + Math.random() * 600, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards' });

            setTimeout(() => ring.remove(), 3500);
          }, delay);
        }
      }
    } else {
      hoverBurstRunning = false;
      // White only — opacity scales from 0.12 (far) to 0.16 (close)
      const alpha = (0.12 + proximity * 0.04).toFixed(3);
      playBtn.style.background = `rgba(255, 255, 255, ${alpha})`;

      const glowStr = proximity * 0.12;
      if (glowStr > 0.01) {
        playBtn.style.filter = `drop-shadow(0 0 ${(10 * proximity).toFixed(0)}px rgba(255,255,255,${glowStr.toFixed(3)}))`;
      } else {
        playBtn.style.filter = '';
      }
    }

    requestAnimationFrame(tickIntroReach);
  }
  requestAnimationFrame(tickIntroReach);

  prevBtn?.addEventListener('click', prev);
  nextBtn?.addEventListener('click', next);
  audio.addEventListener('ended', next);

  // Volume slider
  const volumeRange = document.getElementById('volume-range');
  if (volumeRange) {
    audio.volume = volumeRange.value / 100;
    volumeRange.addEventListener('input', () => {
      audio.volume = volumeRange.value / 100;
    });
  }

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}

export function getAnalyser() {
  return analyser;
}

export function getStereoAnalysers() {
  return analyserL ? { left: analyserL, right: analyserR } : null;
}
