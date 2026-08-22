// POST /api/community/ascend — begin a new creature line.
//
// Deliberately a fan ACTION rather than something that happens automatically
// at 600 EP. Auto-ascending would mean nobody is ever an Emergent: they would
// arrive at the top and be turned back into an egg in the same page load,
// never seeing the creature they spent months earning.
//
// Total XP is never reset. Only `cycle_base_ep` moves, so progress within the
// new line starts at zero while the running total — the site's one standing
// promise to fans — keeps climbing.

import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { getProfileByEmail, ascendCreature } from '../../_lib/community/repo';
import { assignSpriteRefs } from '../../_lib/community/sprites';
import { canAscend, cycleSpan, type CreatureStage } from '../../_lib/community/ep';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestOptions: PagesFunction<CommunityEnv> = async ({ request }) => preflight(request);

export const onRequestPost: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(async ({ request, env }) => {
  const rl = await rateLimit(env, 'ascend', 'ip', clientIp(request), 10, 600);
  if (!rl.ok) return rateLimitedJson(rl);

  const fan = await requireFan(env, request);
  if (!fan) return unauthorized();

  const profile = await getProfileByEmail(env.GATES, fan.email);
  if (!profile) return jsonRes({ error: 'no profile' }, 404);

  const prestige = Math.max(0, Math.floor(Number(profile.prestige) || 0));
  const base = Math.max(0, Math.floor(Number(profile.cycle_base_ep) || 0));
  const ep = Math.max(0, Math.floor(Number(profile.ep) || 0));

  // Checked here for a clear error message, and AGAIN in the UPDATE's WHERE
  // clause, which is what actually makes it safe under concurrency.
  if (!canAscend(profile.stage as CreatureStage | null, ep, base, prestige)) {
    return jsonRes({ error: 'not ready' }, 409);
  }

  const sprites = await assignSpriteRefs(fan.email, prestige + 1);
  const updated = await ascendCreature(env.GATES, fan.email, {
    requiredCycleEp: cycleSpan(prestige),
    nextPrestige: prestige + 1,
    sprites,
  });
  // Null means the guarded UPDATE matched nothing — another request got there
  // first. Not an error to the fan: they ascended, just not on this call.
  if (!updated) return jsonRes({ ok: true, already: true });

  return jsonRes({
    ok: true,
    prestige: updated.prestige,
    stage: 'egg',
    ep: updated.ep,
    sprite_ref: updated.sprite_egg,
  });
});
