import { describe, it, expect } from 'vitest';
import {
  computeEp, stageForEp, nextStageThreshold, resolveStage, stageXp, EP_WEIGHTS, STAGE_THRESHOLDS,
} from '../../functions/_lib/community/ep';

describe('computeEp', () => {
  it('is 0 for no signal at all', () => {
    expect(computeEp({ purchaseCount: 0, tenureDays: 0, engagementActions: 0 })).toBe(0);
  });

  it('weights purchases alone', () => {
    expect(computeEp({ purchaseCount: 1, tenureDays: 0, engagementActions: 0 }))
      .toBe(EP_WEIGHTS.PER_PURCHASE);
    expect(computeEp({ purchaseCount: 3, tenureDays: 0, engagementActions: 0 }))
      .toBe(EP_WEIGHTS.PER_PURCHASE * 3);
  });

  it('weights tenure alone, floored to an integer', () => {
    expect(computeEp({ purchaseCount: 0, tenureDays: 30, engagementActions: 0 }))
      .toBe(Math.floor(30 * EP_WEIGHTS.PER_TENURE_DAY));
  });

  it('weights engagement alone (currently always fed 0 by callers, but the shape works)', () => {
    expect(computeEp({ purchaseCount: 0, tenureDays: 0, engagementActions: 25 }))
      .toBe(25 * EP_WEIGHTS.PER_ENGAGEMENT_ACTION);
  });

  it('combines all three signals additively', () => {
    const ep = computeEp({ purchaseCount: 2, tenureDays: 10, engagementActions: 5 });
    const expected = Math.floor(
      2 * EP_WEIGHTS.PER_PURCHASE + 10 * EP_WEIGHTS.PER_TENURE_DAY + 5 * EP_WEIGHTS.PER_ENGAGEMENT_ACTION,
    );
    expect(ep).toBe(expected);
  });

  it('never goes negative even with malformed/negative inputs', () => {
    expect(computeEp({ purchaseCount: -5, tenureDays: -100, engagementActions: -1 })).toBe(0);
  });

  it('a fan who buys one release and sticks around for about a month hatches', () => {
    // The spec's own bar: "gentle enough that a fan who buys one release and
    // sticks around hatches reasonably soon".
    const ep = computeEp({ purchaseCount: 1, tenureDays: 30, engagementActions: 0 });
    expect(stageForEp(ep)).not.toBe('egg');
  });
});

describe('stageForEp / thresholds', () => {
  it('starts at egg with 0 EP', () => {
    expect(stageForEp(0)).toBe('egg');
  });

  it('boundary just below grub threshold is still egg', () => {
    expect(stageForEp(STAGE_THRESHOLDS.grub - 1)).toBe('egg');
  });

  it('boundary exactly at grub threshold is grub', () => {
    expect(stageForEp(STAGE_THRESHOLDS.grub)).toBe('grub');
  });

  it('boundary just below pupa threshold is still grub', () => {
    expect(stageForEp(STAGE_THRESHOLDS.pupa - 1)).toBe('grub');
  });

  it('boundary exactly at pupa threshold is pupa', () => {
    expect(stageForEp(STAGE_THRESHOLDS.pupa)).toBe('pupa');
  });

  it('boundary just below adult threshold is still pupa', () => {
    expect(stageForEp(STAGE_THRESHOLDS.adult - 1)).toBe('pupa');
  });

  it('boundary exactly at adult threshold is adult', () => {
    expect(stageForEp(STAGE_THRESHOLDS.adult)).toBe('adult');
  });

  it('stays adult well past the threshold', () => {
    expect(stageForEp(STAGE_THRESHOLDS.adult * 10)).toBe('adult');
  });
});

describe('nextStageThreshold', () => {
  it('egg -> grub threshold', () => {
    expect(nextStageThreshold('egg')).toBe(STAGE_THRESHOLDS.grub);
  });

  it('grub -> pupa threshold', () => {
    expect(nextStageThreshold('grub')).toBe(STAGE_THRESHOLDS.pupa);
  });

  it('pupa -> adult threshold', () => {
    expect(nextStageThreshold('pupa')).toBe(STAGE_THRESHOLDS.adult);
  });

  it('adult has no further threshold', () => {
    expect(nextStageThreshold('adult')).toBeNull();
  });
});

describe('resolveStage — never regresses', () => {
  it('a legacy NULL-stage row is treated as egg', () => {
    expect(resolveStage(0, null)).toBe('egg');
  });

  it('advances a fan from their stored stage when EP now justifies more', () => {
    expect(resolveStage(STAGE_THRESHOLDS.pupa, 'grub')).toBe('pupa');
  });

  it('never demotes when EP drops below what the current stage would imply', () => {
    // e.g. a weight tuned down later, or EP computed differently — the fan
    // already earned 'pupa' and must keep it even if today's EP alone
    // would only justify 'grub'.
    expect(resolveStage(STAGE_THRESHOLDS.grub, 'pupa')).toBe('pupa');
  });

  it('never demotes even all the way from adult to egg-level EP', () => {
    expect(resolveStage(0, 'adult')).toBe('adult');
  });

  it('stays at egg if EP still does not justify hatching', () => {
    expect(resolveStage(STAGE_THRESHOLDS.grub - 1, 'egg')).toBe('egg');
  });
});

describe('stageXp — 0..100 within the current stage band', () => {
  it('is 0 at the very start of egg', () => {
    expect(stageXp(0, 'egg')).toBe(0);
  });

  it('is 0 exactly at the start of a later stage (band boundary)', () => {
    expect(stageXp(STAGE_THRESHOLDS.grub, 'grub')).toBe(0);
    expect(stageXp(STAGE_THRESHOLDS.pupa, 'pupa')).toBe(0);
    expect(stageXp(STAGE_THRESHOLDS.adult, 'adult')).toBe(0);
  });

  it('is 100 (not more) right at the next stage boundary, viewed from below', () => {
    expect(stageXp(STAGE_THRESHOLDS.grub - 1, 'egg')).toBeLessThan(100);
    expect(stageXp(STAGE_THRESHOLDS.grub, 'egg')).toBe(100);
    expect(stageXp(STAGE_THRESHOLDS.pupa, 'grub')).toBe(100);
    expect(stageXp(STAGE_THRESHOLDS.adult, 'pupa')).toBe(100);
  });

  it('is halfway through a band at its midpoint', () => {
    const mid = Math.floor((STAGE_THRESHOLDS.grub + STAGE_THRESHOLDS.pupa) / 2);
    expect(stageXp(mid, 'grub')).toBeCloseTo(50, 0);
  });

  it('clamps to [0, 100] even for an out-of-sync (ep, stage) pair', () => {
    expect(stageXp(0, 'adult')).toBe(0);
    expect(stageXp(STAGE_THRESHOLDS.adult * 100, 'adult')).toBe(100);
    expect(stageXp(-50, 'egg')).toBe(0);
  });

  it('adult (the top stage) still produces a finite, growing percentage', () => {
    const near = stageXp(STAGE_THRESHOLDS.adult + 10, 'adult');
    const further = stageXp(STAGE_THRESHOLDS.adult + 100, 'adult');
    expect(near).toBeGreaterThan(0);
    expect(further).toBeGreaterThan(near);
    expect(further).toBeLessThanOrEqual(100);
  });
});
