// POST /api/discord/link-code   { discord_user_id }  ->  { code, expires_at }
//
// Step 1 of the link handshake, called by the bot when a member runs /link.
// The bot shows the returned code to that member privately; they type it
// into /account, which is step 2 (POST /api/community/link-discord).
//
// Bot-authenticated, not session-authenticated — see _lib/community/discord.ts.

import { corsHandler, preflight } from '../../_lib/cors';
import {
  isBot, botNotFound, generateCode, CODE_TTL_SECONDS, type DiscordBotEnv,
} from '../../_lib/community/discord';
import {
  saveDiscordLinkCode, purgeExpiredDiscordLinkCodes, getDiscordLinkByUser,
} from '../../_lib/community/repo';

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

    // Already linked: hand back a clear answer rather than a fresh code that
    // would fail at redemption anyway. The bot turns this into "you're
    // already linked" instead of showing a code that cannot work.
    const existing = await getDiscordLinkByUser(env.GATES, discordUserId);
    if (existing) return json({ error: 'already_linked' }, 409);

    const nowSec = Math.floor(Date.now() / 1000);
    // Opportunistic sweep — no cron exists for this, and issuing a code is
    // exactly when the table is being written anyway.
    await purgeExpiredDiscordLinkCodes(env.GATES, nowSec);

    const code = generateCode();
    const expiresAt = nowSec + CODE_TTL_SECONDS;
    await saveDiscordLinkCode(env.GATES, code, discordUserId, nowSec, expiresAt);

    return json({ code, expires_at: expiresAt, ttl_seconds: CODE_TTL_SECONDS });
  },
);
