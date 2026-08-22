import { describe, it, expect } from 'vitest';
import {
  cycleSpan, cycleThresholds, cycleEp, canAscend, stageForEp, resolveStage, stageXp,
  STAGE_THRESHOLDS,
} from '../../functions/_lib/community/ep';
import { tierSlice, PRESTIGE_TIERS } from '../../functions/_lib/community/sprites';

describe('cycle geometry', () => {
  it('line 0 reproduces the original ladder exactly', () => {
    // The existing 50/200/600 must fall out of the general formula, not sit
    // beside it as a special case — otherwise every fan silently re-ranks the
    // day prestige ships.
    expect(cycleThresholds(0)).toEqual(STAGE_THRESHOLDS);
    expect(cycleSpan(0)).toBe(600);
  });

  it('each later line is longer, so ascending means something', () => {
    expect(cycleSpan(1)).toBe(900);
    expect(cycleSpan(2)).toBe(1200);
    expect(cycleSpan(3)).toBeGreaterThan(cycleSpan(2));
  });

  it('progress is measured within the line, never against the total', () => {
    // A fan on line 1 with 700 total and a base of 600 is 100 into that line —
    // an egg. Reading the total here would hand every ascended fan a
    // fully-grown creature on their next page load.
    // 650 total on a line that began at 600 is 50 into it. Line 1's grub
    // threshold is 75 (900/12), so this fan is still an egg — while the SAME
    // 650 read as a total would be an adult on line 0.
    expect(cycleEp(650, 600)).toBe(50);
    expect(stageForEp(cycleEp(650, 600), 1)).toBe('egg');
    expect(stageForEp(650, 0)).toBe('adult');
  });

  it('never reports negative progress', () => {
    expect(cycleEp(100, 600)).toBe(0);
  });
});

describe('ascension gate', () => {
  it('opens only at the top of a completed line', () => {
    expect(canAscend('adult', 600, 0, 0)).toBe(true);
    expect(canAscend('adult', 599, 0, 0)).toBe(false);
    expect(canAscend('pupa', 5000, 0, 0)).toBe(false);
    expect(canAscend(null, 5000, 0, 0)).toBe(false);
  });

  it('uses the CURRENT line length, not the first one', () => {
    // On line 1 the span is 900, so 600 of cycle EP is not enough.
    expect(canAscend('adult', 1200, 600, 1)).toBe(false);
    expect(canAscend('adult', 1500, 600, 1)).toBe(true);
  });
});

describe('stage never regresses', () => {
  it('resolveStage still refuses to demote within a line', () => {
    expect(resolveStage(0, 'adult', 0)).toBe('adult');
  });

  it('but a new line legitimately starts at egg — that is the WRITE, not the resolver', () => {
    // Ascension sets stage='egg' in SQL. resolveStage is then given cycle EP
    // near zero and a current stage of 'egg', so it agrees.
    expect(resolveStage(0, 'egg', 1)).toBe('egg');
  });
});

describe('stage bands follow the line', () => {
  it('re-bases the progress bar per line instead of using cycle-0 numbers', () => {
    // 200 cycle EP is the top of pupa on line 0 and only two thirds of the way
    // there on line 1. Using the global thresholds would show a fan 100%
    // through a stage they were partway into.
    expect(stageXp(200, 'grub', 0)).toBe(100);
    expect(stageXp(200, 'grub', 1)).toBeLessThan(100);
  });
});

describe('sprite tiers', () => {
  const pool = Array.from({ length: 200 }, (_, i) => `A${i}`);

  it('later lines draw from later, rarer slices', () => {
    const t0 = tierSlice(pool, 0);
    const t1 = tierSlice(pool, 1);
    const t2 = tierSlice(pool, 2);
    expect(t0[0]).toBe('A0');
    expect(t1[0]).not.toBe(t0[0]);
    // The pool is authored plain -> elaborate, so a later slice is strictly
    // further along it. Overlapping tiers would hand an ascended fan a
    // starter creature.
    expect(pool.indexOf(t1[0])).toBeGreaterThan(pool.indexOf(t0[t0.length - 1]));
    expect(pool.indexOf(t2[0])).toBeGreaterThan(pool.indexOf(t1[t1.length - 1]));
  });

  it('the rarest tier is the smallest', () => {
    expect(tierSlice(pool, 2).length).toBeLessThan(tierSlice(pool, 0).length);
  });

  it('a fan past the last tier keeps the rarest set, never wrapping to plain', () => {
    expect(tierSlice(pool, 9)).toEqual(tierSlice(pool, PRESTIGE_TIERS - 1));
  });

  it('never returns an empty slice, even for a tiny pool', () => {
    for (const n of [1, 2, 3, 5]) {
      const small = Array.from({ length: n }, (_, i) => `X${i}`);
      for (let p = 0; p < 4; p++) expect(tierSlice(small, p).length).toBeGreaterThan(0);
    }
  });
});
