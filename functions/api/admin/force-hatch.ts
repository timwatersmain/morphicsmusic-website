// POST /api/admin/force-hatch   { email }
//
// Forces a fan out of 'egg' regardless of current EP — see forceHatch in
// creature.ts. Still refuses to hatch if the species roster has no active
// rows (there would be nothing to assign), and is a no-op — not an error —
// for a fan who has already hatched, since hatching is permanent.
//
// A caller who is not a listed admin gets the same 404 an unknown route
// would — see requireAdmin/adminNotFound in _lib/admin.ts. Never a 403,
// which would confirm this endpoint exists.

import { corsHandler, preflight } from '../../_lib/cors';
import { requireAdmin, adminNotFound, type AdminEnv } from '../../_lib/admin';
import { getProfileByEmail, getSpeciesCatalogue, saveCreatureProgress } from '../../_lib/community/repo';
import { forceHatch } from '../../_lib/community/creature';

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

    let body: { email?: string };
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

    const email = (body.email || '').trim().toLowerCase();
    if (!email) return json({ error: 'email is required' }, 400);

    const profile = await getProfileByEmail(env.GATES, email);
    if (!profile) return json({ error: 'no fan profile for that email' }, 404);

    const now = Math.floor(Date.now() / 1000);
    const speciesRoster = await getSpeciesCatalogue(env.GATES);
    const update = await forceHatch(profile, speciesRoster, now);
    await saveCreatureProgress(env.GATES, profile.id, {
      ep: update.ep, stage: update.stage, species: update.species, hatchedAt: update.hatchedAt,
    });

    if (!update.species) {
      return json({ ok: false, error: 'no active species in creature_species — seed the roster first' }, 409);
    }

    return json({
      ok: true,
      ep: update.ep,
      stage: update.stage,
      species: update.species,
      just_hatched: update.justHatched,
    });
  },
);
