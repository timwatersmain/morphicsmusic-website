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
    const scale = 1 + Math.sin(t * 0.3 + i * 0.7) * 0.012;
    letters[i].style.transform = `translate(${x}px, ${y}px) scale(${scale}) rotate(${driftR}deg)`;
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
    sx: 0.4 + Math.random() * 0.5,
    sy: 0.35 + Math.random() * 0.4,
    sr: 0.3 + Math.random() * 0.4,
    ax: 0.6 + Math.random() * 0.8,
    ay: 0.4 + Math.random() * 0.6,
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

export function tickLetters(time) {
  const letters = cachedLetters;
  if (!letters.length) return;

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

    // Ambient wave
    const wave1 = Math.sin(t * 0.8 + i * 0.6) * 1.2;
    const wave2 = Math.sin(t * 0.5 + i * 0.9 + 2.0) * 0.7;
    const driftX = Math.sin(t * seed.sx + seed.px) * seed.ax;
    const driftY = Math.sin(t * seed.sy + seed.py) * seed.ay;
    const driftR = Math.sin(t * seed.sr + seed.pr) * seed.ar;

    // Combine
    const x = driftX;
    const y = wave1 + wave2 + driftY + s.hoverY + s.bounceY;
    const breathe = Math.sin(t * seed.breatheSpeed + seed.breathePhase) * seed.breatheAmp;
    const scale = 1 + breathe + s.hoverScale + s.bounceS + bulkHover * 0.03;

    const el = letters[i];
    el.style.transform = `translate(${x}px, ${y}px) scale(${scale}) rotate(${driftR}deg)`;

    // Uniform glow: always apply with bulkHover blended in (no threshold snap)
    const g = bulkHover;
    const c = Math.round(200 + g * 42);
    const a = (0.72 + g * 0.16).toFixed(3);
    const glowA = (g * 0.08).toFixed(4);
    el.style.color = `rgba(${c}, ${c - 10}, ${c - 25}, ${a})`;
    el.style.textShadow = `0 0 6px rgba(0,0,0,0.4), 0 0 20px rgba(0,0,0,0.15), 0 0 10px rgba(255,255,255,${glowA})`;
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

      // Capture final button positions BEFORE hiding them
      // Temporarily show the normal layout to measure
      controlsEl.classList.remove('is-intro');
      playBtn.classList.remove('intro-rising', 'intro-hovering', 'leave-ripple');
      const targets = controlsEl.querySelectorAll(':scope > .ctrl-btn, :scope > .volume-wrap');
      const targetPositions = [];
      for (const t of targets) {
        const r = t.getBoundingClientRect();
        targetPositions.push({ x: r.left + r.width / 2 - 20, y: r.top + r.height / 2 - 20 });
      }

      // Now hide everything for the animation
      controlsEl.classList.add('is-transitioning');

      // Phase 1: Bubble pop — squeeze then burst
      const popAnim = playBtn.animate([
        { transform: 'scale(1)', opacity: 1 },
        { transform: 'scale(0.85)', opacity: 1, offset: 0.2 },
        { transform: 'scale(1.15)', opacity: 0.8, offset: 0.4 },
        { transform: 'scale(1.4)', opacity: 0, offset: 0.7 },
        { transform: 'scale(1.4)', opacity: 0, offset: 1.0 },
      ], { duration: 500, easing: 'ease-out', fill: 'forwards' });

      // Spawn 12 particles that trail outward from button center
      const popRect = playBtn.getBoundingClientRect();
      const pcx = popRect.left + popRect.width / 2;
      const pcy = popRect.top + popRect.height / 2;
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

      popAnim.onfinish = () => {
        popAnim.cancel();
        playBtn.classList.add('is-popped');
      };

      // Phase 2: Simple fade in of all controls
      setTimeout(() => {
        controlsEl.classList.remove('is-transitioning');
        targets.forEach(t => {
          t.style.opacity = '0';
          t.style.transform = 'scale(0.9)';
          t.style.transition = 'opacity 2s ease, transform 2s ease';
          requestAnimationFrame(() => {
            t.style.opacity = '1';
            t.style.transform = 'scale(1)';
          });
        });
        playBtn.classList.remove('is-popped');
        playBtn.style.opacity = '0';
        playBtn.style.transform = 'scale(0.9)';
        playBtn.style.transition = 'opacity 2s ease, transform 2s ease';
        requestAnimationFrame(() => {
          playBtn.style.opacity = '1';
          playBtn.style.transform = 'scale(1)';
        });

        // Clean up inline styles after fade completes
        setTimeout(() => {
          targets.forEach(t => { t.style.transition = ''; t.style.opacity = ''; t.style.transform = ''; });
          playBtn.style.transition = ''; playBtn.style.opacity = ''; playBtn.style.transform = '';
        }, 2200);
      }, 1200);

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

        // After pop, hold black then fade in player
        setTimeout(() => {
          if (fragContainer) {
            fragContainer.classList.add('is-hidden');
            fragContainer.style.display = 'none';
          }
          landing.classList.remove('is-intro-mode');

          // Start metaball + player fade in from black
          if (window.__onIntroExit) window.__onIntroExit();
        }, 600);

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
