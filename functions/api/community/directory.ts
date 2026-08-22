// GET /api/community/directory?limit=&offset=
// The fan wall: directory + leaderboard, in one paginated list.
// Answers spec open question §10.3 — it paginates, defaulting to 40 a page
// (see MAX_LIMIT below — the subrequest budget caps it there).

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import { countDirectory, getDirectory, getCatalogue, toPublicProfile } from '../../_lib/community/repo';

export const onRequestOptions: PagesFunction<CommunityEnv> = async ({ request }) => preflight(request);

export const onRequestGet: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(
  async ({ request, env }) => {
    const rl = await rateLimit(env, 'community_dir', 'ip', clientIp(request), 60, 60);
    if (!rl.ok) return rateLimitedJson(rl);

    if (!(await requireFan(request, env))) return unauthorized();

    // Cloudflare Free caps a single request at 50 subrequests. This endpoint
    // spends 5 fixed subrequests (rate-limit get+put, session-version get,
    // getDirectory, getCatalogue) and zero per-fan reads — the page used to
    // also pay for a KV glyph lookup per glyph-styled avatar (up to 40 more),
    // but the glyph letter is no longer derived or sent anywhere, so that
    // cost is gone. Worst case is now a flat 5, regardless of page size.
    // Creature sprite refs/colourway add ZERO subrequests here either: they
    // live as plain columns on the fan_profiles row getDirectory already
    // reads (see sprites.ts/toPublicProfile) — no per-fan or whole-roster
    // D1/KV read, unlike the retired species_catalogue lookup this replaced.
    const MAX_LIMIT = 40;
    const url = new URL(request.url);
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || String(MAX_LIMIT), 10) || MAX_LIMIT, 1),
      MAX_LIMIT,
    );
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

    const [rows, total] = await Promise.all([
      getDirectory(env.GATES, { limit, offset }),
      countDirectory(env.GATES),
    ]);
    const catalogue = await getCatalogue(env.GATES);
    const byId = new Map(catalogue.map(a => [a.id, a]));

    const fans = rows.map((r, i) => {
      const avatar = r.equipped_avatar_id ? byId.get(r.equipped_avatar_id) || null : null;
      return { ...toPublicProfile(r, avatar), position: offset + i + 1 };
    });

    // has_more is derived from the total now, not from "did this page come
    // back full". The old test was wrong on the exact boundary: a final page
    // that happens to hold exactly `limit` rows reported another page after
    // it, which paginated UI renders as a real, empty page.
    return new Response(JSON.stringify({
      fans, limit, offset, total, has_more: offset + rows.length < total,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
);
