import { describe, it, expect } from 'vitest';
import { assignSpecies } from '../../functions/_lib/community/species';
import type { CreatureSpeciesRow } from '../../functions/_lib/community/types';

function species(id: string, weight: number, active = 1): CreatureSpeciesRow {
  return { id, name: id, rarity_weight: weight, art_prefix: id.replace('creature:', ''), active };
}

const ROSTER: CreatureSpeciesRow[] = [
  species('creature:a', 100),
  species('creature:b', 50),
  species('creature:c', 25),
  species('creature:d', 25),
];

describe('assignSpecies', () => {
  it('is stable — the same email always yields the same species', async () => {
    const first = await assignSpecies('fan@example.com', ROSTER);
    const second = await assignSpecies('fan@example.com', ROSTER);
    const third = await assignSpecies('fan@example.com', ROSTER);
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first).not.toBeNull();
  });

  it('is case- and whitespace-insensitive on the email, matching how emails are stored elsewhere', async () => {
    const a = await assignSpecies('Fan@Example.com', ROSTER);
    const b = await assignSpecies(' fan@example.com ', ROSTER);
    expect(a).toBe(b);
  });

  it('different emails can get different species', async () => {
    const results = new Set<string | null>();
    for (let i = 0; i < 40; i++) {
      results.add(await assignSpecies(`fan${i}@example.com`, ROSTER));
    }
    // Not a strict requirement that every id shows up, but with 40 draws
    // across 4 species we should see more than one distinct result.
    expect(results.size).toBeGreaterThan(1);
  });

  it('never picks an inactive species', async () => {
    const withInactive = [...ROSTER, species('creature:never', 1000, 0)];
    for (let i = 0; i < 60; i++) {
      const pick = await assignSpecies(`fan${i}@example.com`, withInactive);
      expect(pick).not.toBe('creature:never');
    }
  });

  it('adding an inactive species never changes anyone\'s existing assignment', async () => {
    const before: Record<string, string | null> = {};
    for (let i = 0; i < 30; i++) {
      before[`fan${i}@example.com`] = await assignSpecies(`fan${i}@example.com`, ROSTER);
    }
    const withInactive = [...ROSTER, species('creature:new-and-inactive', 500, 0)];
    for (let i = 0; i < 30; i++) {
      const email = `fan${i}@example.com`;
      expect(await assignSpecies(email, withInactive)).toBe(before[email]);
    }
  });

  it('returns null when the roster has no active species', async () => {
    expect(await assignSpecies('fan@example.com', [])).toBeNull();
    expect(await assignSpecies('fan@example.com', [species('creature:x', 10, 0)])).toBeNull();
  });

  it('roughly respects rarity_weight across a large sample', async () => {
    const N = 2000;
    const counts: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const pick = await assignSpecies(`sample-fan-${i}@example.com`, ROSTER);
      if (pick) counts[pick] = (counts[pick] || 0) + 1;
    }
    const totalWeight = ROSTER.reduce((s, r) => s + r.rarity_weight, 0);
    for (const row of ROSTER) {
      const expectedFraction = row.rarity_weight / totalWeight;
      const actualFraction = (counts[row.id] || 0) / N;
      // Generous tolerance — this is a hash-derived distribution over a
      // finite sample, not a statistical proof, just a sanity check that
      // weight roughly tracks frequency.
      expect(Math.abs(actualFraction - expectedFraction)).toBeLessThan(0.06);
    }
  });

  it('order of rows in the roster array does not affect the result', async () => {
    const reversed = [...ROSTER].reverse();
    const a = await assignSpecies('order-test@example.com', ROSTER);
    const b = await assignSpecies('order-test@example.com', reversed);
    expect(a).toBe(b);
  });
});
