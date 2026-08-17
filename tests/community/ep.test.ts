import { describe, it, expect } from 'vitest';
import {
  computeEp, stageForEp, nextStageThreshold, resolveStage, EP_WEIGHTS, STAGE_THRESHOLDS,
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

  it('boundary just below larva threshold is still egg', () => {
    expect(stageForEp(STAGE_THRESHOLDS.larva - 1)).toBe('egg');
  });

  it('boundary exactly at larva threshold is larva', () => {
    expect(stageForEp(STAGE_THRESHOLDS.larva)).toBe('larva');
  });

  it('boundary just below chrysalis threshold is still larva', () => {
    expect(stageForEp(STAGE_THRESHOLDS.chrysalis - 1)).toBe('larva');
  });

  it('boundary exactly at chrysalis threshold is chrysalis', () => {
    expect(stageForEp(STAGE_THRESHOLDS.chrysalis)).toBe('chrysalis');
  });

  it('boundary just below emergent threshold is still chrysalis', () => {
    expect(stageForEp(STAGE_THRESHOLDS.emergent - 1)).toBe('chrysalis');
  });

  it('boundary exactly at emergent threshold is emergent', () => {
    expect(stageForEp(STAGE_THRESHOLDS.emergent)).toBe('emergent');
  });

  it('stays emergent well past the threshold', () => {
    expect(stageForEp(STAGE_THRESHOLDS.emergent * 10)).toBe('emergent');
  });
});

describe('nextStageThreshold', () => {
  it('egg -> larva threshold', () => {
    expect(nextStageThreshold('egg')).toBe(STAGE_THRESHOLDS.larva);
  });

  it('larva -> chrysalis threshold', () => {
    expect(nextStageThreshold('larva')).toBe(STAGE_THRESHOLDS.chrysalis);
  });

  it('chrysalis -> emergent threshold', () => {
    expect(nextStageThreshold('chrysalis')).toBe(STAGE_THRESHOLDS.emergent);
  });

  it('emergent has no further threshold', () => {
    expect(nextStageThreshold('emergent')).toBeNull();
  });
});

describe('resolveStage — never regresses', () => {
  it('a legacy NULL-stage row is treated as egg', () => {
    expect(resolveStage(0, null)).toBe('egg');
  });

  it('advances a fan from their stored stage when EP now justifies more', () => {
    expect(resolveStage(STAGE_THRESHOLDS.chrysalis, 'larva')).toBe('chrysalis');
  });

  it('never demotes when EP drops below what the current stage would imply', () => {
    // e.g. a weight tuned down later, or EP computed differently — the fan
    // already earned 'chrysalis' and must keep it even if today's EP alone
    // would only justify 'larva'.
    expect(resolveStage(STAGE_THRESHOLDS.larva, 'chrysalis')).toBe('chrysalis');
  });

  it('never demotes even all the way from emergent to egg-level EP', () => {
    expect(resolveStage(0, 'emergent')).toBe('emergent');
  });

  it('stays at egg if EP still does not justify hatching', () => {
    expect(resolveStage(STAGE_THRESHOLDS.larva - 1, 'egg')).toBe('egg');
  });
});
