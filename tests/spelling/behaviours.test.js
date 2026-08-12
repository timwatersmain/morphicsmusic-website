import { describe, it, expect } from 'vitest';
import { MODES, IDLE_MODE, displace, leadFor, pickMode } from '../../src/scripts/spelling/behaviours.js';

const A = { x: 30, y: 45 };
const B = { x: 88, y: 72 };

describe('MODES', () => {
  it('has the full behaviour set and no duplicates', () => {
    expect(MODES).toHaveLength(25);
    expect(new Set(MODES).size).toBe(25);
    expect(MODES).toContain('direct');
    expect(MODES).toContain('magnet');
    expect(IDLE_MODE).toBe('direct');
  });
});

describe('displace', () => {
  it('lands exactly on the target at tt=1 for every behaviour', () => {
    for (const m of MODES) {
      const p = displace(m, A, B, 1, 0, 0.5, 1000);
      expect(p.x, m + ' missed x').toBeCloseTo(B.x, 6);
      expect(p.y, m + ' missed y').toBeCloseTo(B.y, 6);
    }
  });

  it('starts at the source at tt=0, or a rotation of it', () => {
    // These five rotate (and unwind additionally shrinks) the SOURCE at tt=0
    // before unwinding into the target, so they do not begin at `a`. What must
    // hold is that none of them starts OUTSIDE the source radius — every
    // behaviour is volume-preserving, and a t=0 swell would read as a size pop.
    const rotators = ['swirl', 'orbit', 'unwind', 'vortex', 'furl'];
    const rA = Math.hypot(A.x - 60, A.y - 60);
    for (const m of MODES) {
      const p = displace(m, A, B, 0, 0, 0.5, 1000);
      if (rotators.includes(m)) {
        const r = Math.hypot(p.x - 60, p.y - 60);
        expect(r, m + ' swelled at t=0').toBeLessThanOrEqual(rA + 1e-6);
        expect(r, m + ' collapsed at t=0').toBeGreaterThan(rA * 0.4);
      } else {
        expect(p.x, m + ' moved x at t=0').toBeCloseTo(A.x, 6);
        expect(p.y, m + ' moved y at t=0').toBeCloseTo(A.y, 6);
      }
    }
  });

  it('peaks mid-transition rather than sliding, for the displacing behaviours', () => {
    const straight = (t) => ({
      x: A.x + (B.x - A.x) * t,
      y: A.y + (B.y - A.y) * t
    });
    for (const m of ['implode', 'split', 'shear', 'fold', 'lathe', 'seam', 'quench', 'inhale', 'peel']) {
      const mid = displace(m, A, B, 0.5, 0, 0.5, 1000);
      const line = straight(0.5);
      expect(Math.hypot(mid.x - line.x, mid.y - line.y), m + ' did not depart the line').toBeGreaterThan(0.3);
    }
  });

  it('never sends a point outside a sane artboard neighbourhood', () => {
    for (const m of MODES) {
      for (let tt = 0; tt <= 1.0001; tt += 0.05) {
        const p = displace(m, A, B, tt, 3, 0.31, 5000);
        expect(Number.isFinite(p.x) && Number.isFinite(p.y), m).toBe(true);
        expect(Math.abs(p.x - 60), m + ' x blew out').toBeLessThan(160);
        expect(Math.abs(p.y - 60), m + ' y blew out').toBeLessThan(160);
      }
    }
  });

  it('falls back to plain interpolation for an unknown behaviour', () => {
    const p = displace('nonesuch', A, B, 0.5, 0, 0.5, 1000);
    const q = displace('direct', A, B, 0.5, 0, 0.5, 1000);
    expect(p).toEqual(q);
  });
});

describe('leadFor', () => {
  it('staggers only the staggering behaviours, and stays under 1', () => {
    const staggered = ['wave', 'ripple', 'seam', 'knit', 'boil', 'split', 'cascade', 'snake'];
    for (const m of MODES) {
      const lead = leadFor(m, B, 5, 100, 0.5);
      expect(lead).toBeGreaterThanOrEqual(0);
      expect(lead).toBeLessThan(1);
      if (!staggered.includes(m)) expect(lead, m).toBe(0);
    }
    expect(leadFor('snake', B, 50, 100, 0.5)).toBeCloseTo(0.25, 6);
  });
});

describe('pickMode', () => {
  it('never repeats the previous behaviour back to back', () => {
    let prev = 'direct';
    for (let i = 0; i < 500; i++) {
      const next = pickMode(prev);
      expect(MODES).toContain(next);
      expect(next).not.toBe(prev);
      prev = next;
    }
  });
});
