// POST   /api/community/link-discord   { code }   -> { ok, discord_user_id }
// DELETE /api/community/link-discord              -> { ok }
//
// Step 2 of the link handshake: the signed-in fan redeems the code the bot
// gave them in Discord. Session-authenticated like every other
// /api/community endpoint — this is the step that proves a HUMAN controls
// both the website account and the Discord account, which is the entire
// point of the handshake.
//
// DELETE unlinks. The EP already earned stays on the discord_links row and
// is therefore dropped from the fan's total — that is deliberate: EP earned
// as a Discord identity should not survive disowning that identity, and
// resolveStage means an unlink can still never demote the creature.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import {
  getProfileByEmail, consumeDiscordLinkCode, createDiscordLink,
  getDiscordLinkByFan, getDiscordLinkByUser, deleteDiscordLink,
} from '../../_lib/community/repo';
import { normaliseCode } from '../../_lib/community/discord';

export const onRequestOptions: PagesFunction<CommunityEnv> = async ({ request }) => preflight(request);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestPost: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(
  async ({ request, env }) => {
    // Tighter than most community endpoints: this is the one place an
    // 8-character code can be guessed, so the limit is what makes brute
    // force impractical rather than merely slow. 29^8 combinations against
    // 10 tries per 10 minutes is not a viable attack.
    const rl = await rateLimit(env, 'community_link_discord', 'ip', clientIp(request), 10, 600);
    if (!rl.ok) return rateLimitedJson(rl);

    const email = await requireFan(request, env);
    if (!email) return unauthorized();

    let body: { code?: string };
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

    const code = normaliseCode(body.code);
    if (!code) return json({ error: 'invalid_code' }, 400);

    const profile = await getProfileByEmail(env.GATES, email);
    if (!profile) return json({ error: 'no fan profile' }, 404);

    const already = await getDiscordLinkByFan(env.GATES, profile.id);
    if (already) return json({ error: 'already_linked' }, 409);

    const nowSec = Math.floor(Date.now() / 1000);
    const discordUserId = await consumeDiscordLinkCode(env.GATES, code, nowSec);
    // Unknown and expired are one answer on purpose — distinguishing them
    // tells someone guessing codes whether a guess ever existed.
    if (!discordUserId) return json({ error: 'invalid_code' }, 400);

    // The code was valid, but that Discord account may have been linked to a
    // DIFFERENT fan since the code was issued. Checked here rather than
    // trusted from link-code.ts's check: those are two separate requests
    // with up to CODE_TTL_SECONDS between them. The unique index on
    // discord_user_id is the real backstop; this turns what would be a 500
    // into an honest 409.
    const taken = await getDiscordLinkByUser(env.GATES, discordUserId);
    if (taken) return json({ error: 'discord_account_already_linked' }, 409);

    await createDiscordLink(env.GATES, profile.id, discordUserId, nowSec);
    return json({ ok: true, discord_user_id: discordUserId });
  },
);

export const onRequestDelete: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(
  async ({ request, env }) => {
    const email = await requireFan(request, env);
    if (!email) return unauthorized();

    const profile = await getProfileByEmail(env.GATES, email);
    if (!profile) return json({ error: 'no fan profile' }, 404);

    await deleteDiscordLink(env.GATES, profile.id);
    return json({ ok: true });
  },
);
