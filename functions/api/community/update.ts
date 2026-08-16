// POST /api/community/update  { display_name?, equipped_avatar_id? }
// Fan-owned fields only. A fan may equip only an avatar they have unlocked.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import {
  getProfileByEmail, getUnlockedAvatarIds, updateProfile, regenerateHandleOnFirstName,
} from '../../_lib/community/repo';
import { isValidDisplayName, isBlockedName } from '../../_lib/community/handle';

export const onRequestOptions: PagesFunction<CommunityEnv> = async ({ request }) => preflight(request);

export const onRequestPost: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(
  async ({ request, env }) => {
    const rl = await rateLimit(env, 'community_update', 'ip', clientIp(request), 20, 600);
    if (!rl.ok) return rateLimitedJson(rl);

    const email = await requireFan(request, env);
    if (!email) return unauthorized();

    let body: { display_name?: string; equipped_avatar_id?: string };
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

    const profile = await getProfileByEmail(env.GATES, email);
    if (!profile) return json({ error: 'no profile' }, 404);

    const fields: { displayName?: string; equippedAvatarId?: string | null; handle?: string } = {};

    if (body.display_name !== undefined) {
      const name = String(body.display_name).trim();
      if (!isValidDisplayName(name)) return json({ error: 'invalid_name' }, 400);
      if (isBlockedName(name)) return json({ error: 'blocked_name' }, 400);
      fields.displayName = name;
      // The handle is derived once, at the moment the fan first chooses a
      // name: profiles are created with the untouched default ('Fan') and no
      // Stripe-derived name, so their handle is still a placeholder like
      // "fan-7". Regenerating it here — only while the stored name is still
      // that default — is the fan's one chance to land on a handle that
      // matches the name they actually picked. Every rename after that
      // leaves the handle alone: it is a stable permalink by then, and
      // changing it would break every link to this profile.
      const regenerated = await regenerateHandleOnFirstName(env.GATES, profile.display_name, name);
      if (regenerated) fields.handle = regenerated;
    }

    if (body.equipped_avatar_id !== undefined) {
      const wanted = body.equipped_avatar_id;
      if (wanted === null || wanted === '') {
        fields.equippedAvatarId = null;
      } else {
        const unlocked = await getUnlockedAvatarIds(env.GATES, profile.id);
        if (!unlocked.includes(wanted)) return json({ error: 'not_unlocked' }, 403);
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
