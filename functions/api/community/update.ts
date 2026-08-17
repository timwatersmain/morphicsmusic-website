// POST /api/community/update  { display_name?, handle?, equipped_avatar_id? }
// Fan-owned fields only. A fan may equip only an avatar they have unlocked.
//
// The handle defaults to the account username at profile creation (see
// ensureProfile in repo.ts) but username and handle are separate things —
// changing one here never touches the other. A handle change is allowed at
// most once every HANDLE_CHANGE_COOLDOWN_DAYS (see canChangeHandle), which
// keeps profile links reasonably stable and makes name-squatting expensive
// without permanently freezing anyone out of their own name, unlike the old
// handle_locked model this replaces.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import {
  getProfileByEmail, getProfileByHandle, getUnlockedAvatarIds, getAvatarById, updateProfile,
  canChangeHandle, nextHandleChangeAt,
} from '../../_lib/community/repo';
import { isValidDisplayName, isBlockedName, slugifyHandle } from '../../_lib/community/handle';
import { requireAdmin } from '../../_lib/admin';

export const onRequestOptions: PagesFunction<CommunityEnv> = async ({ request }) => preflight(request);

export const onRequestPost: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(
  async ({ request, env }) => {
    const rl = await rateLimit(env, 'community_update', 'ip', clientIp(request), 20, 600);
    if (!rl.ok) return rateLimitedJson(rl);

    const email = await requireFan(request, env);
    if (!email) return unauthorized();

    let body: { display_name?: string; handle?: string; equipped_avatar_id?: string };
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

    const profile = await getProfileByEmail(env.GATES, email);
    if (!profile) return json({ error: 'no profile' }, 404);

    // Gated on the session that requireFan already verified above — NEVER
    // on anything the request body claims. This lets the site owner use
    // his own name; it must stay session-only and must never be ported to
    // an unauthenticated path like signup, where an email in the body
    // proves nothing about who is asking.
    const isAdmin = !!(await requireAdmin(request, env));

    const fields: {
      displayName?: string; equippedAvatarId?: string | null; handle?: string;
    } = {};

    if (body.display_name !== undefined) {
      const name = String(body.display_name).trim();
      if (!isValidDisplayName(name)) return json({ error: 'invalid_name' }, 400);
      if (!isAdmin && isBlockedName(name)) return json({ error: 'blocked_name' }, 400);
      fields.displayName = name;
    }

    if (body.handle !== undefined) {
      // slugifyHandle always returns a legal handle string (falling back to
      // 'fan'), so there is no separate "malformed handle" rejection path —
      // just the two things that actually matter: reserved words, and
      // whether someone else already owns the exact string requested.
      const wanted = slugifyHandle(String(body.handle));
      if (!isAdmin && isBlockedName(wanted)) return json({ error: 'blocked_handle' }, 400);

      if (wanted !== profile.handle) {
        if (!canChangeHandle(profile.handle_changed_at, Math.floor(Date.now() / 1000))) {
          return json({
            error: 'handle_cooldown',
            next_change_at: nextHandleChangeAt(profile.handle_changed_at as number),
          }, 429);
        }

        const holder = await getProfileByHandle(env.GATES, wanted);
        // A fan who typed a specific handle must be told it's unavailable,
        // not silently handed a suffixed alternative — silent suffixing is
        // only correct for the *derived* default at profile creation, where
        // the fan never chose the string themselves.
        if (holder && holder.id !== profile.id) return json({ error: 'handle_taken' }, 409);

        fields.handle = wanted;
      }
    }

    if (body.equipped_avatar_id !== undefined) {
      const wanted = body.equipped_avatar_id;
      if (wanted === null || wanted === '') {
        fields.equippedAvatarId = null;
      } else {
        const avatar = await getAvatarById(env.GATES, wanted);
        // Tier 1 (glyph_solid) is available to every fan from signup by
        // rule, not by ledger row — see the 'tier1_default' UnlockRule.
        // Requiring a fan_avatar_unlocks row for it would mean writing six
        // redundant grants (one per colourway) to every fan's ledger for
        // something everyone already has.
        const tierOneFree = avatar?.tier === 1;
        if (!tierOneFree) {
          const unlocked = await getUnlockedAvatarIds(env.GATES, profile.id);
          if (!unlocked.includes(wanted)) return json({ error: 'not_unlocked' }, 403);
        }
        fields.equippedAvatarId = wanted;
      }
    }

    await updateProfile(env.GATES, profile.id, fields);
    return json({ ok: true });
  },
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
