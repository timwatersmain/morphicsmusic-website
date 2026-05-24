// Shared preview player for the Morphics store.
// One <audio> element, one track at a time. Any element with
// [data-preview-key] becomes a play/pause toggle for that preview MP3
// (served by /api/preview). The icon span inside the button (or the button
// itself) swaps between play_arrow / pause / progress_activity.

let audio = null;
let currentKey = null;
let currentBtn = null;

function ensureAudio() {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'none';
  audio.addEventListener('ended', () => setIcon(currentBtn, 'play_arrow'));
  audio.addEventListener('pause', () => { if (audio.ended) return; setIcon(currentBtn, 'play_arrow'); });
  audio.addEventListener('play', () => setIcon(currentBtn, 'pause'));
  audio.addEventListener('waiting', () => setIcon(currentBtn, 'progress_activity'));
  audio.addEventListener('playing', () => setIcon(currentBtn, 'pause'));
  audio.addEventListener('error', () => { setIcon(currentBtn, 'play_arrow'); });
  return audio;
}

function iconEl(btn) {
  if (!btn) return null;
  return btn.querySelector('.material-symbols-outlined') || btn;
}

function setIcon(btn, name) {
  const el = iconEl(btn);
  if (!el) return;
  el.textContent = name;
  if (btn) btn.classList.toggle('preview-playing', name === 'pause' || name === 'progress_activity');
}

function toggle(key, btn) {
  const a = ensureAudio();
  if (currentKey === key) {
    if (a.paused) { a.play().catch(() => {}); } else { a.pause(); }
    return;
  }
  // Switch tracks: reset the previously active button.
  if (currentBtn && currentBtn !== btn) setIcon(currentBtn, 'play_arrow');
  currentKey = key;
  currentBtn = btn;
  a.src = `/api/preview?key=${encodeURIComponent(key)}`;
  setIcon(btn, 'progress_activity');
  a.play().catch(() => setIcon(btn, 'play_arrow'));
}

window.morphicsPreview = { toggle };

// Delegated click handling so dynamically-rendered buttons work too.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-preview-key]');
  if (!btn) return;
  e.preventDefault();
  const key = btn.getAttribute('data-preview-key');
  if (key) toggle(key, btn);
});
