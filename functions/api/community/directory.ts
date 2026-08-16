// GET /api/community/directory?limit=&offset=
// The fan wall: directory + leaderboard, in one paginated list.
// Answers spec open question §10.3 — it paginates, defaulting to 48 a page.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import { getDirectory, getCatalogue, toPublicProfile } from '../../_lib/community/repo';
import { glyphLetterForEmail } from '../../_lib/community/glyph';

export const onRequestOptions: PagesFunction<CommunityEnv> = async ({ request }) => preflight(request);

export const onRequestGet: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(
  async ({ request, env }) => {
    const rl = await rateLimit(env, 'community_dir', 'ip', clientIp(request), 60, 60);
    if (!rl.ok) return rateLimitedJson(rl);

    if (!(await requireFan(request, env))) return unauthorized();

    const url = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '48', 10) || 48, 1), 100);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

    const rows = await getDirectory(env.GATES, { limit, offset });
    const catalogue = await getCatalogue(env.GATES);
    const byId = new Map(catalogue.map(a => [a.id, a]));

    // One glyph lookup per fan on the page (a KV get each — this endpoint
    // caps at 100 rows) run concurrently rather than serially awaited in
    // the map below, since each is independent of the others.
    const fans = await Promise.all(rows.map(async (r, i) => ({
      ...toPublicProfile(
        r,
        r.equipped_avatar_id ? byId.get(r.equipped_avatar_id) || null : null,
        await glyphLetterForEmail(env, r.email),
      ),
      position: offset + i + 1,
    })));

    return new Response(JSON.stringify({ fans, limit, offset, has_more: rows.length === limit }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
);
