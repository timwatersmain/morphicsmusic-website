// POST /api/community/engagement
// { new_clicks, active_seconds, seq, listens?: [{ key, started, progress_seconds, duration_seconds }] }
//
// The client reports WHAT HAPPENED — a count of newly-seen unique
// interactive elements, seconds of genuinely active visible-tab time, and
// per-track listen progress. It never reports an XP amount, and any such
// field would be ignored here regardless: applyEngagementReport (see
// functions/_lib/community/engagement.ts) is the ONLY place that turns a
// report into EP, deriving it fresh from stored per-day state every call.
//
// Subrequest budget (worst case, every branch hit): rate-limit KV get+put
// (2) + requireFan's session-version KV get (1) + profile D1 read (1) +
// engagement D1 write (1) = 5. No per-fan fan-out, no batch — flat 5
// regardless of how many clicks/listens are in the report.
//
// This endpoint never creates a profile — a fan must have visited
// /api/community/me at least once first (that's what creates the row). That
// keeps this endpoint to a single profile read rather than also paying for
// ensureProfile's KV customer-record lookup.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import { getProfileByEmail, getEngagementState, saveEngagementState } from '../../_lib/community/repo';
import {
  applyEngagementReport, utcDayKey, CLICK_XP_DAILY_CAP, TIME_XP_DAILY_CAP, LISTEN_XP_DAILY_CAP,
  type ListenReportEntry,
} from '../../_lib/community/engagement';

export const onRequestOptions: PagesFunction<CommunityEnv> = async ({ request }) => preflight(request);

interface EngagementBody {
  new_clicks?: unknown;
  active_seconds?: unknown;
  seq?: unknown;
  listens?: unknown;
}

function sanitizeListens(raw: unknown): ListenReportEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ListenReportEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const key = typeof o.key === 'string' ? o.key : '';
    if (!key) continue;
    out.push({
      key,
      started: o.started === true,
      progressSeconds: Number(o.progress_seconds) || 0,
      durationSeconds: Number(o.duration_seconds) || 0,
    });
  }
  return out;
}

export const onRequestPost: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(
  async ({ request, env }) => {
    // Same 'ip' bucket convention every other /api/community endpoint uses
    // (see update.ts, directory.ts) — cheap (no D1) and catches an
    // unauthenticated flood before requireFan is even reached. A signed-in
    // fan's own heartbeat cadence (at most once a minute — see
    // engagement-tracker.js's HEARTBEAT_INTERVAL_MS) sits far under this;
    // the real anti-farm defence is the server-side caps in
    // applyEngagementReport, not this flood guard, so this matches
    // community_me's generous 60/60s rather than trying to double as a
    // second rate-limiting layer.
    const rl = await rateLimit(env, 'community_engagement', 'ip', clientIp(request), 60, 60);
    if (!rl.ok) return rateLimitedJson(rl);

    const email = await requireFan(request, env);
    if (!email) return unauthorized();

    let body: EngagementBody;
    try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }

    const profile = await getProfileByEmail(env.GATES, email);
    if (!profile) return json({ error: 'no_profile' }, 404);

    const state = await getEngagementState(env.GATES, profile.id);
    const result = applyEngagementReport(
      state,
      {
        newClicks: Number(body.new_clicks) || 0,
        activeSeconds: Number(body.active_seconds) || 0,
        listens: sanitizeListens(body.listens),
        seq: Number(body.seq) || 0,
      },
      utcDayKey(Date.now()),
    );
    await saveEngagementState(env.GATES, profile.id, result.state);

    return json({
      ok: true,
      awarded_ep: result.awardedEp,
      clicks_today: result.state.clicksToday,
      click_cap: CLICK_XP_DAILY_CAP,
      time_cap: TIME_XP_DAILY_CAP,
      listen_xp_today: result.state.listenXpToday,
      listen_cap: LISTEN_XP_DAILY_CAP,
    });
  },
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
