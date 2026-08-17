import { describe, it, expect } from 'vitest';
import { evaluateCreature, grantEp, forceHatch } from '../../functions/_lib/community/creature';
import { STAGE_THRESHOLDS } from '../../functions/_lib/community/ep';

function profile(over: Partial<{ stage: string | null; ep: number }> = {}) {
  return { stage: null, ep: 0, ...over };
}

describe('evaluateCreature', () => {
  it('stays egg with no EP', async () => {
    const u = await evaluateCreature(profile(), { purchaseCount: 0, tenureDays: 0, engagementActions: 0 });
    expect(u.stage).toBe('egg');
    expect(u.justHatched).toBe(false);
  });

  it('advances past egg the moment EP crosses the grub threshold', async () => {
    const inputs = { purchaseCount: 2, tenureDays: 0, engagementActions: 0 }; // >= grub threshold
    const u = await evaluateCreature(profile(), inputs);
    expect(u.stage).not.toBe('egg');
    expect(u.justHatched).toBe(true);
  });

  it('is idempotent: calling again with an already-advanced profile does not re-flag justHatched', async () => {
    const inputs = { purchaseCount: 2, tenureDays: 0, engagementActions: 0 };
    const first = await evaluateCreature(profile(), inputs);
    const alreadyAdvanced = profile({ stage: first.stage });
    const second = await evaluateCreature(alreadyAdvanced, inputs);
    expect(second.stage).toBe(first.stage);
    expect(second.justHatched).toBe(false);
  });

  it('never regresses stage even if a later call sees lower EP', async () => {
    const hatched = profile({ stage: 'pupa' });
    const u = await evaluateCreature(hatched, { purchaseCount: 0, tenureDays: 0, engagementActions: 0 });
    expect(u.stage).toBe('pupa');
  });

  it('a NULL-stage legacy row is treated as egg going in', async () => {
    const legacy = profile({ stage: null });
    const u = await evaluateCreature(legacy, { purchaseCount: 0, tenureDays: 0, engagementActions: 0 });
    expect(u.stage).toBe('egg');
  });
});

describe('grantEp (admin)', () => {
  it('adds EP on top of what the fan already has and can trigger an advance past egg', () => {
    const p = profile({ ep: 0 });
    const u = grantEp(p, STAGE_THRESHOLDS.grub);
    expect(u.ep).toBe(STAGE_THRESHOLDS.grub);
    expect(u.stage).not.toBe('egg');
    expect(u.justHatched).toBe(true);
  });

  it('never lets EP go negative', () => {
    const p = profile({ ep: 5 });
    const u = grantEp(p, -100);
    expect(u.ep).toBe(0);
  });

  it('never regresses an already-advanced fan even with a negative grant', () => {
    const p = profile({ ep: STAGE_THRESHOLDS.pupa, stage: 'pupa' });
    const u = grantEp(p, -1000);
    expect(u.stage).toBe('pupa');
  });
});

describe('forceHatch (admin)', () => {
  it('advances an egg immediately regardless of EP', () => {
    const p = profile({ ep: 0 });
    const u = forceHatch(p);
    expect(u.stage).not.toBe('egg');
    expect(u.justHatched).toBe(true);
  });

  it('is a no-op — not a regression — for a fan who already advanced', () => {
    const p = profile({ ep: 10, stage: 'grub' });
    const u = forceHatch(p);
    expect(u.stage).toBe('grub');
    expect(u.justHatched).toBe(false);
  });
});
