// POST /api/community/restore  { discard?: boolean }
//
// The other half of the soft delete in delete.ts. A fan whose profile is
// inside its grace window has exactly two ways out, and both live here:
//
//   discard falsy (the normal case) — restore it. Bio, engagement EP,
//     handle, creature, colourway, hatched date: all still on the row, so
//     the profile comes back as it was, not as a fresh one wearing the same
//     name.
//   discard true — purge it now, forfeiting the window on purpose. This is
//     for the fan who meant it and wants their handle released, or who wants
//     to start over from scratch immediately rather than wait 30 days.
//
// Like delete.ts, the target is always the caller's own profile: there is no
// id or handle parameter, so this cannot be pointed at anybody else.
//
// No password is required to RESTORE, deliberately — unlike deletion. The
// asymmetry is on purpose: restoring is non-destructive and returns the
// account's own data to the account, so the session is a proportionate
// check. Discarding IS destructive, so it takes the same password proof
// deletion did — otherwise "delete needs your password" would be trivially
// bypassable by anyone holding a session of a fan who happened to be inside
// their window.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import {
  getDeletedProfileByEmail, restoreFanProfile, purgeFanProfile, isGraceExpired,
} from '../../_lib/community/repo';
import { getCustomerRecord } from '../../_lib/customer';
import { verifyPassword, dummyVerify, type PasswordEnv } from '../../_lib/password';

type RestoreEnv = CommunityEnv & PasswordEnv;

export const onRequestOptions: PagesFunction<RestoreEnv> = async ({ request }) => preflight(request);

export const onRequestPost: PagesFunction<RestoreEnv> = corsHandler<RestoreEnv>(
  async ({ request, env }) => {
    const rl = await rateLimit(env, 'community_restore', 'ip', clientIp(request), 10, 3600);
    if (!rl.ok) return rateLimitedJson(rl);

    const email = await requireFan(request, env);
    if (!email) return unauthorized();

    let body: { discard?: boolean; password?: string };
    try { body = await request.json(); } catch { body = {}; }

    const profile = await getDeletedProfileByEmail(env.GATES, email);
    // Nothing pending. Either they never deleted, or they already restored
    // in another tab — both are the state the caller wants, so this is not
    // an error, and it must not leak which of the two it was.
    if (!profile) return json({ ok: true, nothing_pending: true });

    const nowSec = Math.floor(Date.now() / 1000);

    // The window already lapsed but the sweep has not reached this row yet.
    // Honour the deadline, not the sweep's schedule: restoring here would
    // resurrect a profile the fan was promised was permanently gone.
    if (isGraceExpired(profile.deleted_at ?? null, nowSec)) {
      await purgeFanProfile(env.GATES, profile.id);
      return json({ error: 'grace_expired' }, 410);
    }

    if (body.discard) {
      const customer = await getCustomerRecord(env, email);
      if (!customer?.password) {
        await dummyVerify(env).catch(() => {});
        return json({ error: 'password_not_set' }, 400);
      }
      const { ok } = await verifyPassword(env, String(body.password || ''), customer.password);
      if (!ok) return json({ error: 'bad_password' }, 403);
      await purgeFanProfile(env.GATES, profile.id);
      return json({ ok: true, discarded: true });
    }

    await restoreFanProfile(env.GATES, profile.id);
    return json({ ok: true, restored: true, handle: profile.handle });
  },
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
