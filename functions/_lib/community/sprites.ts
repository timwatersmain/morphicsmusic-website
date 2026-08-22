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
import { NATIVE_COLOURWAY } from '../../../src/scripts/sprites/native-palette';

export { NATIVE_COLOURWAY };

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

/**
 * How many prestige tiers the catalogue is divided into. The sprite set is
 * already ordered plain -> elaborate within each stage (plain-egg ... 
 * paperlantern-egg; owlwing-moth ... nebular-sphinx-graft), so a later line
 * simply draws from a later slice. Nothing about the art had to change — the
 * gradient was already authored into it.
 */
export const PRESTIGE_TIERS = 3;

/** Fractional cut points. Tier 0 is the widest because it is the line every
 *  fan starts on and most will never leave; the top tier is the narrowest so
 *  the rarest creatures stay rare. */
const TIER_BOUNDS = [0, 0.45, 0.78, 1];

/** The slice of a stage's pool a given prestige level draws from. Levels past
 *  the last tier keep drawing from it rather than erroring or wrapping back to
 *  the plain end — a fan on their fifth line must never be handed a starter
 *  egg again. */
export function tierSlice(refs: string[], prestige: number): string[] {
  const tier = Math.min(Math.max(0, Math.floor(Number(prestige) || 0)), PRESTIGE_TIERS - 1);
  const lo = Math.floor(refs.length * TIER_BOUNDS[tier]);
  const hi = Math.max(lo + 1, Math.floor(refs.length * TIER_BOUNDS[tier + 1]));
  return refs.slice(lo, hi);
}

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
export async function assignSpriteForStage(
  email: string, stage: SpriteStage, prestige = 0,
): Promise<string> {
  const refs = tierSlice(SPRITE_REFS_BY_STAGE[stage], prestige);
  // The prestige level is part of the hash, so a fan's second line is not a
  // reshuffle of their first — it is an independent draw from a different
  // pool. Without it, the same email would land on the same relative index in
  // every tier and the lines would feel like recolours of one another.
  const hex = await sha256Hex(`${SPRITE_SALT}:${stage}:${prestige}:${email.toLowerCase().trim()}`);
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
export async function assignSpriteRefs(email: string, prestige = 0): Promise<SpriteAssignment> {
  const [egg, grub, pupa, adult, colourway] = await Promise.all([
    assignSpriteForStage(email, 'egg', prestige),
    assignSpriteForStage(email, 'grub', prestige),
    assignSpriteForStage(email, 'pupa', prestige),
    assignSpriteForStage(email, 'adult', prestige),
    assignColourway(email),
  ]);
  return { sprite_egg: egg, sprite_grub: grub, sprite_pupa: pupa, sprite_adult: adult, colourway };
}

/**
 * Whether `id` is one of the 12 real colourways OR the NATIVE_COLOURWAY
 * sentinel ("render the sprite's own authored palette") — the only values
 * update.ts may persist into fan_profiles.colourway. Deliberately still an
 * allow-list, not "any string": adding the sentinel must never loosen this
 * into accepting arbitrary input.
 */
export function isValidColourway(id: string): boolean {
  return id === NATIVE_COLOURWAY || COLOURWAY_IDS.includes(id);
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
