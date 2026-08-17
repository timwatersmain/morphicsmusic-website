import { describe, it, expect } from 'vitest';
import { evaluateCreature, grantEp, forceHatch, creatureArtPath } from '../../functions/_lib/community/creature';
import { STAGE_THRESHOLDS } from '../../functions/_lib/community/ep';
import type { CreatureSpeciesRow } from '../../functions/_lib/community/types';

const NOW = 1_800_000_000;
const ROSTER: CreatureSpeciesRow[] = [
  { id: 'creature:a', name: 'Species A', rarity_weight: 100, art_prefix: 'species-a', active: 1 },
  { id: 'creature:b', name: 'Species B', rarity_weight: 100, art_prefix: 'species-b', active: 1 },
];
const EMPTY_ROSTER: CreatureSpeciesRow[] = [];

function profile(over: Partial<{ email: string; stage: string | null; species: string | null; hatched_at: number | null; ep: number }> = {}) {
  return {
    email: 'fan@example.com', stage: null, species: null, hatched_at: null, ep: 0, ...over,
  };
}

describe('evaluateCreature', () => {
  it('stays egg with no EP', async () => {
    const u = await evaluateCreature(profile(), { purchaseCount: 0, tenureDays: 0, engagementActions: 0 }, ROSTER, NOW);
    expect(u.stage).toBe('egg');
    expect(u.species).toBeNull();
    expect(u.hatchedAt).toBeNull();
    expect(u.justHatched).toBe(false);
  });

  it('hatches (assigns a species) the moment EP crosses the larva threshold', async () => {
    const inputs = { purchaseCount: 2, tenureDays: 0, engagementActions: 0 }; // >= larva threshold
    const u = await evaluateCreature(profile(), inputs, ROSTER, NOW);
    expect(u.stage).not.toBe('egg');
    expect(u.species).not.toBeNull();
    expect(u.hatchedAt).toBe(NOW);
    expect(u.justHatched).toBe(true);
  });

  it('is idempotent: calling again with an already-hatched profile does not re-flag justHatched or reassign species', async () => {
    const inputs = { purchaseCount: 2, tenureDays: 0, engagementActions: 0 };
    const first = await evaluateCreature(profile(), inputs, ROSTER, NOW);
    const alreadyHatched = profile({ stage: first.stage, species: first.species, hatched_at: first.hatchedAt });
    const second = await evaluateCreature(alreadyHatched, inputs, ROSTER, NOW + 1000);
    expect(second.species).toBe(first.species);
    expect(second.hatchedAt).toBe(first.hatchedAt);
    expect(second.justHatched).toBe(false);
  });

  it('refuses to hatch when the species roster is empty, even with plenty of EP', async () => {
    const inputs = { purchaseCount: 100, tenureDays: 0, engagementActions: 0 };
    const u = await evaluateCreature(profile(), inputs, EMPTY_ROSTER, NOW);
    expect(u.stage).toBe('egg');
    expect(u.species).toBeNull();
  });

  it('never regresses stage even if a later call sees lower EP', async () => {
    const hatched = profile({ stage: 'chrysalis', species: 'creature:a', hatched_at: NOW });
    const u = await evaluateCreature(hatched, { purchaseCount: 0, tenureDays: 0, engagementActions: 0 }, ROSTER, NOW + 1);
    expect(u.stage).toBe('chrysalis');
  });

  it('a NULL-stage legacy row is treated as egg going in', async () => {
    const legacy = profile({ stage: null });
    const u = await evaluateCreature(legacy, { purchaseCount: 0, tenureDays: 0, engagementActions: 0 }, ROSTER, NOW);
    expect(u.stage).toBe('egg');
  });
});

describe('grantEp (admin)', () => {
  it('adds EP on top of what the fan already has and can trigger a hatch', async () => {
    const p = profile({ ep: 0 });
    const u = await grantEp(p, STAGE_THRESHOLDS.larva, ROSTER, NOW);
    expect(u.ep).toBe(STAGE_THRESHOLDS.larva);
    expect(u.stage).not.toBe('egg');
    expect(u.species).not.toBeNull();
  });

  it('never lets EP go negative', async () => {
    const p = profile({ ep: 5 });
    const u = await grantEp(p, -100, ROSTER, NOW);
    expect(u.ep).toBe(0);
  });

  it('never regresses an already-hatched fan even with a negative grant', async () => {
    const p = profile({ ep: STAGE_THRESHOLDS.chrysalis, stage: 'chrysalis', species: 'creature:a', hatched_at: NOW });
    const u = await grantEp(p, -1000, ROSTER, NOW + 1);
    expect(u.stage).toBe('chrysalis');
    expect(u.species).toBe('creature:a');
  });
});

describe('forceHatch (admin)', () => {
  it('hatches an egg immediately regardless of EP', async () => {
    const p = profile({ ep: 0 });
    const u = await forceHatch(p, ROSTER, NOW);
    expect(u.stage).not.toBe('egg');
    expect(u.species).not.toBeNull();
    expect(u.justHatched).toBe(true);
  });

  it('is a no-op for a fan who already hatched — species is permanent', async () => {
    const p = profile({ ep: 10, stage: 'larva', species: 'creature:a', hatched_at: NOW });
    const u = await forceHatch(p, ROSTER, NOW + 1);
    expect(u.species).toBe('creature:a');
    expect(u.justHatched).toBe(false);
  });

  it('refuses when the roster is empty', async () => {
    const p = profile({ ep: 0 });
    const u = await forceHatch(p, EMPTY_ROSTER, NOW);
    expect(u.species).toBeNull();
    expect(u.stage).toBe('egg');
  });
});

describe('creatureArtPath', () => {
  const species: CreatureSpeciesRow = { id: 'creature:a', name: 'A', rarity_weight: 1, art_prefix: 'a', active: 1 };

  it('is null for an egg regardless of species', () => {
    expect(creatureArtPath(species, 'egg')).toBeNull();
  });

  it('is null when no species is resolved', () => {
    expect(creatureArtPath(null, 'larva')).toBeNull();
  });

  it('resolves the documented filename convention for a hatched stage', () => {
    expect(creatureArtPath(species, 'larva')).toBe('/images/creatures/a-larva.webp');
    expect(creatureArtPath(species, 'chrysalis')).toBe('/images/creatures/a-chrysalis.webp');
    expect(creatureArtPath(species, 'emergent')).toBe('/images/creatures/a-emergent.webp');
  });
});
