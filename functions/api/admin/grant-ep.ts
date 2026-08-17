// POST /api/admin/grant-ep   { email, amount }
//
// Adds `amount` EP to a fan directly (on top of whatever computeEp would
// give them from purchases/tenure/engagement) and re-runs the same stage
// decision the natural path uses (see grantEp in creature.ts) — so an admin
// grant that pushes a fan out of 'egg' advances them exactly like a real
// visit would. Sprite refs/colourway were already fixed at profile creation
// and are untouched here.
//
// A caller who is not a listed admin gets the same 404 an unknown route
// would — see requireAdmin/adminNotFound in _lib/admin.ts. Never a 403,
// which would confirm this endpoint exists.

import { corsHandler, preflight } from '../../_lib/cors';
import { requireAdmin, adminNotFound, type AdminEnv } from '../../_lib/admin';
import { getProfileByEmail, saveCreatureProgress } from '../../_lib/community/repo';
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
    const update = grantEp(profile, amount);
    const hatchedAt = update.justHatched ? now : profile.hatched_at;
    await saveCreatureProgress(env.GATES, profile.id, {
      ep: update.ep, stage: update.stage, hatchedAt,
    });

    return json({
      ok: true,
      ep: update.ep,
      stage: update.stage,
      just_hatched: update.justHatched,
    });
  },
);
