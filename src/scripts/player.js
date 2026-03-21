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
let animationId = null;
let isPlaying = false;

// DOM references (set in init)
let titleEl, playBtn, prevBtn, nextBtn, canvas, ctx;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function updateTitle() {
  if (titleEl && tracks[currentIndex]) {
    titleEl.textContent = tracks[currentIndex].title;
  }
}

function updatePlayButton() {
  if (playBtn) {
    playBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    playBtn.querySelector('.play-icon').style.display = isPlaying ? 'none' : 'block';
    playBtn.querySelector('.pause-icon').style.display = isPlaying ? 'block' : 'none';
  }
}

function loadTrack(index) {
  if (!audio || !tracks[index]) return;
  currentIndex = index;
  audio.src = tracks[index].url;
  updateTitle();
}

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source = audioCtx.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

async function play() {
  if (!audio || !tracks.length) return;
  ensureAudioContext();
  resizeCanvas();
  try {
    await audio.play();
    isPlaying = true;
    updatePlayButton();
    drawWaveform();
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

function resizeCanvas() {
  if (!canvas) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
}

export async function init() {
  // Get DOM elements
  titleEl = document.getElementById('player-title');
  playBtn = document.getElementById('player-play');
  prevBtn = document.getElementById('player-prev');
  nextBtn = document.getElementById('player-next');
  canvas = document.getElementById('player-waveform');

  if (!titleEl || !playBtn || !canvas) {
    console.warn('Player elements not found');
    return;
  }

  ctx = canvas.getContext('2d');

  // Create audio element
  audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.preload = 'metadata';

  // Fetch and shuffle tracks
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

  // Load first track (paused)
  loadTrack(0);

  // Wire controls
  playBtn.addEventListener('click', togglePlay);
  prevBtn?.addEventListener('click', prev);
  nextBtn?.addEventListener('click', next);

  // Auto-advance on track end
  audio.addEventListener('ended', next);

  // Resize canvas
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}

export function getAnalyser() {
  return analyser;
}
