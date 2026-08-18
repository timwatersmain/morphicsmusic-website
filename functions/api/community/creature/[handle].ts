// GET /api/community/creature/<handle>[.png]?size=128
//
// A fan's creature as a real PNG, so it can appear anywhere that takes an
// image URL — specifically Discord embeds (/rank), which cannot run the
// site's canvas renderer.
//
// PUBLIC and unauthenticated, deliberately: this renders exactly what the
// fan wall at /community already shows to everyone. It exposes no email, no
// EP total and no Discord id — just the creature art. A fan hidden from the
// wall is still excluded (see the hidden check below), so "hidden" keeps
// meaning hidden.
//
// The heavy sprite data is NOT bundled. This fetches the one sprite it
// needs from public/sprites/ref/<REF>.json (~1.2KB, written by
// scripts/build-sprite-assets.mjs) rather than pulling the 519KB catalogue
// into a Worker with a 10ms CPU budget.
//
// The XP transform and palette come from the SAME vendored modules the
// browser renderer uses (src/scripts/sprites/vendor/*), imported directly
// rather than reimplemented — they are pure array maths with no DOM, and a
// second implementation would drift from the art the fan sees on the site.

import { frame } from '../../../../src/scripts/sprites/vendor/recipes.js';
import { COLORWAYS, paletteOf } from '../../../../src/scripts/sprites/vendor/colorways.js';
import { NATIVE_COLOURWAY } from '../../../../src/scripts/sprites/native-palette.js';
import { getProfileByHandle } from '../../../_lib/community/repo';
import { stageXp, type CreatureStage } from '../../../_lib/community/ep';
import { encodeIndexedPng } from '../../../_lib/community/sprite-png';

interface Env {
  GATES: D1Database;
}

// 32px source art. Only integer scales are allowed — pixel art resampled to
// a non-multiple blurs, which is the one thing the vendored README is
// explicit about. Requests are snapped to the nearest allowed size rather
// than rejected, so a caller asking for 100 gets 96 instead of a 400.
const SPRITE_PX = 32;
const ALLOWED_SIZES = [32, 64, 96, 128, 160, 192, 224, 256];
const DEFAULT_SIZE = 128;

export function resolveSize(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SIZE;
  return ALLOWED_SIZES.reduce(
    (best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best),
    ALLOWED_SIZES[0],
  );
}

/** Strip an optional .png so the URL can look like an image to any client. */
export function normaliseHandle(raw: string): string {
  return String(raw || '').trim().toLowerCase().replace(/\.png$/, '');
}

const COLOURWAY_BY_ID = Object.fromEntries(COLORWAYS.map((c: any) => [c.id, c]));

export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
  const handle = normaliseHandle(params.handle as string);
  if (!handle) return new Response('Not found', { status: 404 });

  const profile = await getProfileByHandle(env.GATES, handle);
  // A hidden fan is hidden here too — otherwise this endpoint would be a
  // way to read a creature the fan removed from the wall.
  if (!profile || profile.hidden_from_wall) return new Response('Not found', { status: 404 });

  const stage = (profile.stage || 'egg') as CreatureStage;
  const ref = profile.override_sprite
    || (stage === 'egg' ? profile.sprite_egg
      : stage === 'grub' ? profile.sprite_grub
      : stage === 'pupa' ? profile.sprite_pupa
      : profile.sprite_adult);
  // A profile predating migration 0007 has no refs until its owner's next
  // /me visit backfills them (repo.ts's ensureSpriteAssignment). Nothing to
  // draw yet — and this endpoint must not write, so it cannot backfill.
  if (!ref) return new Response('Not found', { status: 404 });

  const origin = new URL(request.url).origin;
  const res = await fetch(`${origin}/sprites/ref/${encodeURIComponent(ref)}.json`);
  if (!res.ok) return new Response('Not found', { status: 404 });
  const sprite = await res.json() as {
    ref: string; stage: string; base: string[]; palette: Record<string, string | null>;
  };

  // The same 0..100 the browser renderer is handed via creature.stage_xp,
  // from the same function — the PNG must show the same amount of cracking
  // or growth the fan sees on their own profile page.
  const xp = stageXp(profile.ep || 0, stage);
  const grid = frame(sprite, xp, 0);

  // 'native' means "the sprite's own authored palette"; NULL means the fan
  // has never chosen, which falls back to a real colourway. See
  // src/scripts/sprites/native-palette.js for why those are distinct states.
  const palette = profile.colourway === NATIVE_COLOURWAY
    ? sprite.palette
    : paletteOf(COLOURWAY_BY_ID[profile.colourway || ''] || COLORWAYS[0]);

  const size = resolveSize(new URL(request.url).searchParams.get('size'));
  const png = encodeIndexedPng(grid, palette, { scale: size / SPRITE_PX });

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      // Short cache: a creature changes when its owner earns EP or swaps
      // colourway, and a stale avatar in Discord for an hour would make the
      // molt announcement and the picture disagree. Long enough to absorb
      // an embed being re-fetched by every client viewing the channel.
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
