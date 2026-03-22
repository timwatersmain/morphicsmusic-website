/** Morphics Landing Page — Audio reactor
 *  - Audio bands: bass/mid/high via AnalyserNode
 *  - Drives CSS custom properties on <html>
 */

const ema = { bass: 0, mid: 0, high: 0 };
let freqBuffer = null;

function readBands(analyser) {
  if (!analyser) return ema;
  if (!freqBuffer || freqBuffer.length !== analyser.frequencyBinCount) {
    freqBuffer = new Uint8Array(analyser.frequencyBinCount);
  }
  analyser.getByteFrequencyData(freqBuffer);
  let bass = 0, mid = 0, high = 0;
  for (let i = 0;  i < 10;  i++) bass += freqBuffer[i];
  for (let i = 10; i < 93;  i++) mid  += freqBuffer[i];
  for (let i = 93; i < 930; i++) high += freqBuffer[i];
  const a = 0.15;
  ema.bass += a * (bass / (10 * 255) - ema.bass);
  ema.mid  += a * (mid  / (83 * 255) - ema.mid);
  ema.high += a * (high / (837 * 255) - ema.high);
  return ema;
}

// Returns a tick function to be called from a single master rAF loop
export function initCSSReactor(getAnalyser) {
  const root = document.documentElement;
  // Pre-allocate strings — only update CSS when values change meaningfully
  let prevBass = '', prevMid = '', prevHigh = '';

  return function tick() {
    const analyser = getAnalyser();
    readBands(analyser);
    const b = ema.bass.toFixed(3);
    const m = ema.mid.toFixed(3);
    const h = ema.high.toFixed(3);
    if (b !== prevBass) { root.style.setProperty('--audio-bass', b); prevBass = b; }
    if (m !== prevMid)  { root.style.setProperty('--audio-mid',  m); prevMid  = m; }
    if (h !== prevHigh) { root.style.setProperty('--audio-high', h); prevHigh = h; }
  };
}
