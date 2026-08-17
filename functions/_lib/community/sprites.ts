// Deterministic sprite + colourway assignment for a fan's creature.
//
// Same technique the (now-retired) species.ts used: derive the pick from a
// hash of the fan's email plus a fixed server-side salt, never Math.random(),
// so it is reproducible and never lost to a failed write. Unlike the old
// species model, all four stage sprites AND the colourway are picked once,
// at profile creation (see ensureProfile in repo.ts) — a fan's whole journey
// is settled from the start and never re-rolls. The colourway is the one
// part of that a fan can change later (see setCreatureColourway); the sprite
// refs are permanent.
//
// SPRITE_REFS_BY_STAGE is generated (see scripts/build-sprite-assets.mjs) —
// it carries only `ref` strings, not the ~613KB of grid/palette/recipe data,
// so this module (and the profile-creation path that calls it) never touches
// the full sprite dataset. That full dataset is a client-only asset — see
// src/scripts/sprites/data-url.generated.js.

import { SPRITE_REFS_BY_STAGE } from './sprite-refs.generated';
import { COLORWAYS } from '../../../src/scripts/sprites/vendor/colorways';

export type SpriteStage = 'egg' | 'grub' | 'pupa' | 'adult';

export interface SpriteAssignment {
  sprite_egg: string;
  sprite_grub: string;
  sprite_pupa: string;
  sprite_adult: string;
  colourway: string;
}

// Fixed and never rotated — same reasoning as species.ts's SPECIES_SALT: an
// already-assigned fan's sprites/colourway are stored, never re-derived, so
// rotating this would only ever affect fans who haven't been assigned yet,
// while making a manual "why did fan X get sprite Y" audit unreproducible.
const SPRITE_SALT = 'morphics-creature-sprite-salt-v1';

export const COLOURWAY_IDS: string[] = COLORWAYS.map((c: { id: string }) => c.id);

// Flattened once at module load — the same 401 refs SPRITE_REFS_BY_STAGE
// carries, just without the per-stage grouping. Used only to validate a
// ref exists at all (see isValidSpriteRef); assignment still walks the
// per-stage arrays directly.
const ALL_SPRITE_REFS: Set<string> = new Set(Object.values(SPRITE_REFS_BY_STAGE).flat());

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  // Web Crypto, not a Node built-in — this runs in the Workers runtime.
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Deterministic index into `length` buckets from a hex digest's first 32 bits. */
function pickIndex(hex: string, length: number): number {
  const n = parseInt(hex.slice(0, 8), 16);
  return n % length;
}

/**
 * Deterministically pick one sprite ref for a single stage. Exported mainly
 * for tests; assignSpriteRefs is the entry point every real caller uses.
 */
export async function assignSpriteForStage(email: string, stage: SpriteStage): Promise<string> {
  const refs = SPRITE_REFS_BY_STAGE[stage];
  const hex = await sha256Hex(`${SPRITE_SALT}:${stage}:${email.toLowerCase().trim()}`);
  return refs[pickIndex(hex, refs.length)];
}

/** Deterministically pick a colourway id (one of the 12 in COLOURWAY_IDS). */
export async function assignColourway(email: string): Promise<string> {
  const hex = await sha256Hex(`${SPRITE_SALT}:colourway:${email.toLowerCase().trim()}`);
  return COLOURWAY_IDS[pickIndex(hex, COLOURWAY_IDS.length)];
}

/**
 * The full, permanent assignment for a new fan: one sprite ref per stage
 * plus a colourway. Called once, at profile creation (ensureProfile in
 * repo.ts) — never re-derived for a fan who already has these stored, which
 * is what makes "adding/removing sprites later never changes anyone's
 * existing assignment" true for everyone assigned before that change.
 */
export async function assignSpriteRefs(email: string): Promise<SpriteAssignment> {
  const [egg, grub, pupa, adult, colourway] = await Promise.all([
    assignSpriteForStage(email, 'egg'),
    assignSpriteForStage(email, 'grub'),
    assignSpriteForStage(email, 'pupa'),
    assignSpriteForStage(email, 'adult'),
    assignColourway(email),
  ]);
  return { sprite_egg: egg, sprite_grub: grub, sprite_pupa: pupa, sprite_adult: adult, colourway };
}

/** Whether `id` is one of the 12 real colourways — the only values update.ts may persist. */
export function isValidColourway(id: string): boolean {
  return COLOURWAY_IDS.includes(id);
}

/**
 * Whether `ref` is one of the 401 real sprite refs — the only values
 * update.ts may persist into fan_profiles.override_sprite (migration 0008).
 * This is the server-side gate on the admin sprite picker: a POST straight
 * to the API with a made-up ref must be rejected here, not merely hidden
 * from the UI.
 */
export function isValidSpriteRef(ref: string): boolean {
  return ALL_SPRITE_REFS.has(ref);
}
