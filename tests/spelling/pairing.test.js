import { describe, it, expect } from 'vitest';
import { assign, box } from '../../src/scripts/spelling/pairing.js';

const ring = (n, r, phase = 0) =>
  Array.from({ length: n }, (_, i) => {
    const a = phase + (i / n) * Math.PI * 2;
    return { x: 60 + Math.cos(a) * r, y: 60 + Math.sin(a) * r };
  });

describe('assign', () => {
  it('returns one target per source and uses every target exactly once', () => {
    const src = ring(96, 20), dst = ring(96, 34, 0.7);
    const out = assign(src, dst);
    expect(out).toHaveLength(96);
    expect(new Set(out).size).toBe(96);
    for (const p of out) expect(dst).toContain(p);
  });

  it('keeps points in their own angular sector, so none crosses the centre', () => {
    const src = ring(240, 20), dst = ring(240, 30);
    const out = assign(src, dst);
    for (let i = 0; i < src.length; i++) {
      const a0 = Math.atan2(src[i].y - 60, src[i].x - 60);
      const a1 = Math.atan2(out[i].y - 60, out[i].x - 60);
      let d = Math.abs(a1 - a0);
      if (d > Math.PI) d = Math.PI * 2 - d;
      // 24 sectors is 15 degrees each; allow one sector of slack.
      expect(d).toBeLessThan((Math.PI * 2) / 24 + 0.01);
    }
  });

  it('pairs by radius within a sector, so an inner ring maps to an inner ring', () => {
    const src = [...ring(24, 10), ...ring(24, 40)];
    const dst = [...ring(24, 12), ...ring(24, 44)];
    const out = assign(src, dst);
    for (let i = 0; i < 24; i++) {
      expect(Math.hypot(out[i].x - 60, out[i].y - 60)).toBeLessThan(20);
    }
  });
});

describe('box', () => {
  it('measures centre and extent', () => {
    const b = box([{ x: 40, y: 50 }, { x: 80, y: 70 }]);
    expect(b.cx).toBe(60);
    expect(b.cy).toBe(60);
    expect(b.w).toBe(40);
    expect(b.h).toBe(20);
  });

  it('never reports a zero dimension, so the framing lock cannot divide by zero', () => {
    const b = box([{ x: 60, y: 60 }, { x: 60, y: 60 }]);
    expect(b.w).toBe(1);
    expect(b.h).toBe(1);
  });
});
