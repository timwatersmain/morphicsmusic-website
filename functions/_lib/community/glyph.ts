// Derives which letter a fan's glyph-styled avatar (tiers 1, 2, 4) renders.
// The glyph is never stored per-avatar — a catalogue row is a recipe
// (style + colourway [+ artwork_key]), not a picture. Every fan wearing
// "tier 1 / cyan" sees their own letter.
//
// public/fonts/MorphianTrial-Regular.woff2 contains all 26 letters and
// nothing else — no digits, no underscore, no hyphen. Usernames allow
// [a-z0-9_-], so this picks the first alphabetic character, skipping any
// leading digits/symbols, and falls back to a fixed house letter when the
// username has no letter at all.

const HOUSE_LETTER = 'm';

/** Lowercase glyph letter for a username. Pure — no I/O, no font access. */
export function glyphLetterFor(username: string): string {
  const match = username.toLowerCase().match(/[a-z]/);
  return match ? match[0] : HOUSE_LETTER;
}

// Fans have no `username` column in fan_profiles (it lives only in the KV
// customer record, keyed by email — see functions/_lib/customer.ts). This
// is the one place that crosses that boundary to turn "a fan's email" into
// "the single public glyph letter", so every endpoint that needs another
// fan's glyph (profile.ts, directory.ts — not just the self view in me.ts,
// which already has the record loaded) does it the same way instead of
// hand-rolling a KV read. Only the derived letter ever leaves this function.
import { getCustomerRecord, type CustomerEnv } from '../customer';

export async function glyphLetterForEmail(env: CustomerEnv, email: string): Promise<string> {
  const record = await getCustomerRecord(env, email);
  return glyphLetterFor(record?.username || '');
}
