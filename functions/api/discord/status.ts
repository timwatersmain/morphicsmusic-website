// POST /api/discord/status  { discord_user_id }
//   -> { ok, ep, stage, label, discord_ep, next_threshold, handle }
//
// The read counterpart to award.ts, for /rank. Deliberately read-only: it
// reports the STORED stage and EP rather than recomputing, so checking your
// rank can never advance it. (Tenure accrues continuously, so recomputing
// here would make /rank a way to tick your creature forward without doing
// anything — /me is the one place a read is meant to advance you.)
//
// POST rather than GET despite being a read: a Discord user id in a query
// string ends up in request logs and any cache key along the way, and this
// is called on every /rank.

import { corsHandler, preflight } from '../../_lib/cors';
import { isBot, botNotFound, type DiscordBotEnv } from '../../_lib/community/discord';
import { getDiscordLinkByUser, getProfileById } from '../../_lib/community/repo';
import { STAGE_LABELS, nextStageThreshold, rankLabelFor, type CreatureStage } from '../../_lib/community/ep';

export const onRequestOptions: PagesFunction<DiscordBotEnv> = async ({ request }) => preflight(request);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestPost: PagesFunction<DiscordBotEnv> = corsHandler<DiscordBotEnv>(
  async ({ request, env }) => {
    if (!isBot(request, env)) return botNotFound();

    let body: { discord_user_id?: string };
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

    const discordUserId = String(body.discord_user_id || '').trim();
    if (!discordUserId) return json({ error: 'discord_user_id is required' }, 400);

    const link = await getDiscordLinkByUser(env.GATES, discordUserId);
    if (!link) return json({ error: 'not_linked' }, 404);

    // Same reading as award.ts: getProfileById filters `deleted_at IS NULL`,
    // so a fan inside the 30-day delete grace window lands here with a live
    // link and no profile. Reported as not_linked so the two endpoints agree
    // on what that state IS — nothing is lost either way (this endpoint
    // writes nothing, and /rank maps any 404 to the same copy), but two
    // endpoints answering differently about one state is how the next
    // person reading this gets it wrong.
    const profile = await getProfileById(env.GATES, link.fan_id);
    if (!profile) return json({ error: 'not_linked' }, 404);

    const stage = (profile.stage || 'egg') as CreatureStage;
    return json({
      ok: true,
      ep: profile.ep || 0,
      stage,
      label: rankLabelFor(stage, profile.handle),
      discord_ep: link.discord_ep,
      next_threshold: nextStageThreshold(stage),
      handle: profile.handle,
    });
  },
);
