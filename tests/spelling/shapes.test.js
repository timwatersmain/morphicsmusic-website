import { describe, it, expect } from 'vitest';
import { spherePoints, blobShape, ease, easeOut } from '../../src/scripts/spelling/shapes.js';

const radius = p => Math.hypot(p.x - 60, p.y - 60);

describe('spherePoints', () => {
  it('returns exactly n points inside radius 30 of the artboard centre', () => {
    const pts = spherePoints(500);
    expect(pts).toHaveLength(500);
    for (const p of pts) expect(radius(p)).toBeLessThanOrEqual(30.0001);
  });

  it('fills the disc rather than outlining it', () => {
    const pts = spherePoints(500);
    const inner = pts.filter(p => radius(p) < 15).length;
    expect(inner).toBeGreaterThan(80);
  });
});

describe('blobShape', () => {
  it('returns exactly n points and never the same mass twice', () => {
    const a = blobShape(420), b = blobShape(420);
    expect(a).toHaveLength(420);
    expect(b).toHaveLength(420);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('stays a soft mass — every point well inside the artboard', () => {
    for (let run = 0; run < 20; run++) {
      for (const p of blobShape(420)) {
        expect(radius(p)).toBeLessThan(50);
      }
    }
  });
});

describe('easing', () => {
  it('pins both ends', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
  });

  it('is monotonic', () => {
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const v = ease(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('is symmetric about the midpoint', () => {
    expect(ease(0.5)).toBeCloseTo(0.5, 6);
    expect(ease(0.25) + ease(0.75)).toBeCloseTo(1, 6);
  });
});
