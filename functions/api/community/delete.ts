// POST /api/community/delete  { confirm_handle, password }
// Self-serve deletion of the caller's OWN community profile. There is no id
// or handle parameter naming a target: the profile deleted is always the one
// belonging to the verified session, so this endpoint cannot be pointed at
// anybody else no matter what the body says.
//
// Two independent checks stand in front of the delete, and both are enforced
// HERE, server-side, not just in the page's dialog:
//
//   1. `confirm_handle` must match the caller's own handle exactly. That is a
//      deliberate-action check, not a security one (the session is the
//      security boundary) - it exists so a mis-click, a stale tab or a
//      replayed request cannot destroy a profile that took months of tenure
//      to grow.
//   2. `password` must be the account's current password. A live session
//      cookie proves the browser was signed in at some point; it does not
//      prove the person at the keyboard right now is the owner. Re-entering
//      the password is what an unattended laptop, a shared machine or a
//      stolen cookie cannot do. An account that has never set a password
//      (magic-link only) cannot delete until it sets one at /account - the
//      alternative would be a weaker second path around this check, which
//      would make the check pointless.
//
// This is a SOFT delete (migration 0012). The profile vanishes from every
// surface the moment this returns — fan wall, public profile link, their own
// profile page, engagement earning — but the row survives for
// DELETE_GRACE_DAYS so the fan can undo an accidental deletion themselves via
// POST /api/community/restore. Nothing here is recoverable-by-support-ticket
// theatre: the restore is self-serve, and after the window the row is hard
// deleted for real (purgeExpiredProfiles / the opportunistic purge in me.ts).
//
// What goes: rank, EP, creature, colourway, bio and unlocks — hidden now,
// gone permanently once the window lapses. What survives regardless: the
// ACCOUNT and its KV customer record, so every purchase and download
// entitlement is untouched. The confirmation copy on /community/me states
// exactly that split, so nobody deletes a profile believing they are deleting
// an account, or vice versa.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import { getProfileByEmail, softDeleteFanProfile, purgeDueAt } from '../../_lib/community/repo';
import { getCustomerRecord } from '../../_lib/customer';
import { verifyPassword, dummyVerify, type PasswordEnv } from '../../_lib/password';

type DeleteEnv = CommunityEnv & PasswordEnv;

export const onRequestOptions: PagesFunction<DeleteEnv> = async ({ request }) => preflight(request);

export const onRequestPost: PagesFunction<DeleteEnv> = corsHandler<DeleteEnv>(
  async ({ request, env }) => {
    // Far tighter than update.ts's 20/10min: nobody legitimately deletes
    // their profile more than a couple of times, and the retry loop this
    // shuts down is exactly the one that would matter.
    const rl = await rateLimit(env, 'community_delete', 'ip', clientIp(request), 5, 3600);
    if (!rl.ok) return rateLimitedJson(rl);

    const email = await requireFan(request, env);
    if (!email) return unauthorized();

    let body: { confirm_handle?: string; password?: string };
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

    const profile = await getProfileByEmail(env.GATES, email);
    // Already gone (double submit, or two tabs) is the state the caller
    // asked for, so this is a 200, not a 404 - a second click must not
    // surface an error for work that is already done.
    if (!profile) return json({ ok: true, already_deleted: true });

    const confirm = String(body.confirm_handle || '').trim().toLowerCase();
    if (confirm !== profile.handle) return json({ error: 'confirm_mismatch' }, 400);

    // Password check runs AFTER the handle check purely so a typo in the
    // handle costs no PBKDF2 work; neither ordering leaks anything, since a
    // caller who got this far already proved they hold the session.
    const customer = await getCustomerRecord(env, email);
    if (!customer?.password) {
      // No password on the account at all. Burn a dummy verify so this path
      // is not distinguishable by timing from a wrong password, then say
      // plainly what to do — this is a real dead end for the fan, not an
      // error to swallow.
      await dummyVerify(env).catch(() => {});
      return json({ error: 'password_not_set' }, 400);
    }
    const { ok } = await verifyPassword(env, String(body.password || ''), customer.password);
    if (!ok) return json({ error: 'bad_password' }, 403);

    const deletedAt = Math.floor(Date.now() / 1000);
    await softDeleteFanProfile(env.GATES, profile.id, deletedAt);
    // The caller gets the deadline back so the page can say a date rather
    // than "30 days", which is only true at the instant of deletion.
    return json({ ok: true, deleted_at: deletedAt, restore_until: purgeDueAt(deletedAt) });
  },
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
