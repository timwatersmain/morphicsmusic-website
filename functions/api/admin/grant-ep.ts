// POST /api/admin/grant-ep   { email, amount }
//
// Adds `amount` EP to a fan and re-runs the same stage decision the natural
// path uses (see grantEp in creature.ts) — so an admin grant that pushes a
// fan out of 'egg' advances them exactly like a real visit would. Sprite
// refs/colourway were already fixed at profile creation and are untouched.
//
// The grant is written to the xp_events LEDGER, not straight to
// fan_profiles.ep. Writing it to the column was the old behaviour and it was
// broken: computeEp() recalculates ep from purchases/tenure/engagement on
// every profile read, so the grant was silently erased the next time the fan
// opened their own profile, leaving them advanced a stage with none of the
// XP that justified it. A ledger row survives the recompute because
// computeEp now sums it in.
//
// `event_key` doubles as a double-submit guard: an identical grant to the
// same fan, for the same amount, within the same second is treated as the
// retry it almost certainly is and awarded once.
//
// A caller who is not a listed admin gets the same 404 an unknown route
// would — see requireAdmin/adminNotFound in _lib/admin.ts. Never a 403,
// which would confirm this endpoint exists.

import { corsHandler, preflight } from '../../_lib/cors';
import { requireAdmin, adminNotFound, type AdminEnv } from '../../_lib/admin';
import { getProfileByEmail, saveCreatureProgress, recordXpEvent, sumLedgerXp } from '../../_lib/community/repo';
import { grantEp } from '../../_lib/community/creature';

interface Env extends AdminEnv {
  GATES: D1Database;
}

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestPost: PagesFunction<Env> = corsHandler<Env>(
  async ({ request, env }) => {
    const admin = await requireAdmin(request, env);
    if (!admin) return adminNotFound();

    let body: { email?: string; amount?: number };
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

    const email = (body.email || '').trim().toLowerCase();
    const amount = Number(body.amount);
    if (!email || !Number.isFinite(amount) || amount === 0) {
      return json({ error: 'email and a non-zero numeric amount are required' }, 400);
    }

    const profile = await getProfileByEmail(env.GATES, email);
    if (!profile) return json({ error: 'no fan profile for that email' }, 404);

    const now = Math.floor(Date.now() / 1000);
    const recorded = await recordXpEvent(env.GATES, {
      fanId: profile.id,
      actionType: 'admin_grant',
      xpAmount: amount,
      eventKey: `admin_grant:${profile.id}:${now}:${amount}`,
      sourceRef: admin,
    });
    // A duplicate submit awards nothing further, but must still report the
    // fan's real standing rather than an error — the caller's intent (this
    // fan should have that grant) is satisfied either way.
    if (!recorded) {
      const ledger = await sumLedgerXp(env.GATES, profile.id);
      return json({
        ok: true, duplicate: true, ep: profile.ep, ledger_xp: ledger, stage: profile.stage,
        just_hatched: false,
      });
    }

    const update = grantEp(profile, amount);
    const hatchedAt = update.justHatched ? now : profile.hatched_at;
    // Still cache ep/stage on the row so the fan wall and public profile
    // reflect the grant immediately, without waiting for the fan's next
    // visit. The ledger is the source of truth; this is the cache catching up.
    await saveCreatureProgress(env.GATES, profile.id, {
      ep: update.ep, stage: update.stage, hatchedAt,
    });

    return json({
      ok: true,
      ep: update.ep,
      ledger_xp: await sumLedgerXp(env.GATES, profile.id),
      stage: update.stage,
      just_hatched: update.justHatched,
    });
  },
);
