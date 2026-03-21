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
