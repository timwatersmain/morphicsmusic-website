// POST /api/community/delete  { confirm_handle }
// Self-serve deletion of the caller's OWN community profile. There is no id
// or handle parameter naming a target: the profile deleted is always the one
// belonging to the verified session, so this endpoint cannot be pointed at
// anybody else no matter what the body says.
//
// `confirm_handle` must match the caller's own handle exactly. That is a
// deliberate-action check, not a security one (the session is the security
// boundary) - it exists so a mis-click, a stale tab or a replayed request
// cannot destroy a profile that took months of tenure to grow.
//
// What is destroyed: the fan_profiles row and the fan_avatar_unlocks ledger,
// which together are rank, EP, creature, colourway, bio and unlocks. What
// survives: the ACCOUNT and its KV customer record, so every purchase and
// download entitlement is untouched and signing in again rebuilds a fresh
// profile (see ensureProfile in repo.ts). The confirmation copy on
// /community/me states exactly that split, so nobody deletes a profile
// believing they are deleting an account, or vice versa.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import { getProfileByEmail, deleteFanProfile } from '../../_lib/community/repo';

export const onRequestOptions: PagesFunction<CommunityEnv> = async ({ request }) => preflight(request);

export const onRequestPost: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(
  async ({ request, env }) => {
    // Far tighter than update.ts's 20/10min: nobody legitimately deletes
    // their profile more than a couple of times, and the retry loop this
    // shuts down is exactly the one that would matter.
    const rl = await rateLimit(env, 'community_delete', 'ip', clientIp(request), 5, 3600);
    if (!rl.ok) return rateLimitedJson(rl);

    const email = await requireFan(request, env);
    if (!email) return unauthorized();

    let body: { confirm_handle?: string };
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

    const profile = await getProfileByEmail(env.GATES, email);
    // Already gone (double submit, or two tabs) is the state the caller
    // asked for, so this is a 200, not a 404 - a second click must not
    // surface an error for work that is already done.
    if (!profile) return json({ ok: true, already_deleted: true });

    const confirm = String(body.confirm_handle || '').trim().toLowerCase();
    if (confirm !== profile.handle) return json({ error: 'confirm_mismatch' }, 400);

    await deleteFanProfile(env.GATES, profile.id);
    return json({ ok: true });
  },
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
