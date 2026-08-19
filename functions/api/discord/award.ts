// POST /api/discord/award  { discord_user_id, amount }
//   -> { ok, ep, stage, label, discord_ep, next_threshold, just_hatched }
//
// The whole merge, in one endpoint. The bot dedups and rate-caps activity
// locally (services/storage/xp_db.py) and posts only the NET delta here;
// this adds it to the fan's Discord EP, re-runs the same stage decision
// GET /api/community/me runs, persists it, and hands the resulting stage
// back so the bot can paint the matching role.
//
// The bot never decides a rank. It reports activity and is told a stage.

import { corsHandler, preflight } from '../../_lib/cors';
import { isBot, botNotFound, clampAward, type DiscordBotEnv } from '../../_lib/community/discord';
import {
  getDiscordLinkByUser, addDiscordEp, getProfileById, saveCreatureProgress, sumLedgerXp,
  claimAwardEvent,
} from '../../_lib/community/repo';
import { evaluateCreature } from '../../_lib/community/creature';
import { epInputsFor, ownedSlugsFromRecord } from '../../_lib/community/ep-inputs';
import { STAGE_LABELS, nextStageThreshold } from '../../_lib/community/ep';

interface Env extends DiscordBotEnv {
  DOWNLOADS: KVNamespace;
}

// Generous next to a real key (~40 chars) but far below anything that
// could be mistaken for payload smuggling.
const MAX_EVENT_KEY_LENGTH = 200;

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestPost: PagesFunction<Env> = corsHandler<Env>(
  async ({ request, env }) => {
    if (!isBot(request, env)) return botNotFound();

    let body: { discord_user_id?: string; amount?: number; event_key?: string };
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

    const discordUserId = String(body.discord_user_id || '').trim();
    if (!discordUserId) return json({ error: 'discord_user_id is required' }, 400);

    const amount = clampAward(body.amount);
    if (amount === null) return json({ error: 'amount must be a non-zero number' }, 400);

    const link = await getDiscordLinkByUser(env.GATES, discordUserId);
    // Not an error: most of the server is unlinked, and the bot calls this
    // for anyone who is active. 404 lets the bot skip painting a role
    // without treating a normal state as a failure.
    if (!link) return json({ error: 'not_linked' }, 404);

    // Resolve the profile BEFORE writing any EP. Ordering is the whole point
    // here, not style: getProfileById filters `deleted_at IS NULL`, and
    // migration 0012 made "a live link pointing at a profile this query will
    // not return" a ROUTINE state lasting the whole 30-day delete grace
    // window rather than the impossible one it was when this was written.
    // With the write first, every award in that window was charged and then
    // 404'd — and because the bot marks the award paid locally under a
    // permanent UNIQUE(user_id, source, ref) key and has no outbox to retry
    // with, the two sides diverged permanently with nothing able to
    // self-correct.
    //
    // A fan inside the grace window is reported as not_linked, exactly like
    // any unlinked member: the bot skips painting a role, nothing is
    // written, and no EP is charged that could never be credited. EP earned
    // while someone has asked to be deleted is legitimately forfeited, and
    // restoring the profile resumes earning cleanly.
    const profile = await getProfileById(env.GATES, link.fan_id);
    if (!profile) return json({ error: 'not_linked' }, 404);

    // Idempotency. The bot cannot tell "the site never received this" from
    // "the site received it and the reply was lost", so it retries — and
    // addDiscordEp is a RELATIVE increment, meaning a replay would add again
    // and leave the fan at a permanently inflated rank (resolveStage never
    // demotes). An event_key that has been seen before is therefore applied
    // ZERO more times, and the current state is reported instead.
    //
    // Reporting 200 rather than an error on a duplicate is deliberate: the
    // bot treats non-2xx as "still undelivered" and would keep the award
    // queued forever, turning a retry storm into a failure storm.
    const eventKey = String(body.event_key || '').trim();
    // Reject rather than truncate. Truncating meant two keys sharing a
    // prefix collided, and a collision reads as "already applied" — so the
    // second award would be silently DROPPED. That is the precise failure
    // this whole mechanism exists to remove, and it would be invisible.
    // Real keys are (kind, message id, user id) and nowhere near this bound,
    // so anything longer is a caller bug worth surfacing loudly.
    if (eventKey.length > MAX_EVENT_KEY_LENGTH) {
      return json({ error: 'event_key too long' }, 400);
    }
    const alreadyApplied = eventKey
      ? !(await claimAwardEvent(env.GATES, eventKey, Math.floor(Date.now() / 1000)))
      : false;

    // An absent event_key keeps the pre-idempotency behaviour, so an older
    // bot build still works — it just cannot be retried safely, which is
    // precisely why the bot drops those rather than queueing them.
    const discordEp = alreadyApplied
      ? link.discord_ep
      : await addDiscordEp(env.GATES, discordUserId, amount);
    // The link vanished between statements — a real unlink racing this
    // request. Nothing was written, so there is nothing to undo.
    if (discordEp === null) return json({ error: 'not_linked' }, 404);

    // Purchases and tenure still come from the same places /me reads them,
    // via the same shared assembly — see _lib/community/ep-inputs.ts for why
    // this must not be rebuilt inline.
    const raw = await env.DOWNLOADS.get(`customer:${profile.email}`);
    let record: { purchases?: Array<{ music_release_slugs?: string[]; digital_slugs?: string[] }> } = {};
    try { if (raw) record = JSON.parse(raw); } catch { /* treat as empty */ }

    const nowSec = Math.floor(Date.now() / 1000);
    const owned = ownedSlugsFromRecord(record);
    const update = await evaluateCreature(
      profile,
      epInputsFor(profile, owned.size, nowSec, discordEp, await sumLedgerXp(env.GATES, profile.id)),
    );

    const hatchedAt = update.justHatched ? nowSec : profile.hatched_at;
    await saveCreatureProgress(env.GATES, profile.id, {
      ep: update.ep, stage: update.stage, hatchedAt,
    });

    return json({
      ok: true,
      ep: update.ep,
      stage: update.stage,
      label: STAGE_LABELS[update.stage],
      discord_ep: discordEp,
      next_threshold: nextStageThreshold(update.stage),
      just_hatched: update.justHatched,
      handle: profile.handle,
      // Lets the bot log a replay distinctly from a fresh award; it treats
      // both as delivered either way.
      duplicate: alreadyApplied,
    });
  },
);
