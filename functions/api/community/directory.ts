// GET /api/community/directory?limit=&offset=
// The fan wall: directory + leaderboard, in one paginated list.
// Answers spec open question §10.3 — it paginates, defaulting to 40 a page
// (see MAX_LIMIT below — the subrequest budget caps it there).

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

    // Cloudflare Free caps a single request at 50 subrequests, and every
    // glyph lookup below is a KV get — one per fan on the page. This
    // endpoint spends 5 fixed subrequests (rate-limit get+put, session-
    // version get, getDirectory, getCatalogue), so the page size must stay
    // well under 50 even in the worst case where every fan on the page wears
    // a glyph avatar (5 fixed + 40 glyph KV reads = 45, still under the cap).
    // Creature sprite refs/colourway add ZERO subrequests here: they live as
    // plain columns on the fan_profiles row getDirectory already reads (see
    // sprites.ts/toPublicProfile) — no per-fan or whole-roster D1/KV read,
    // unlike the retired species_catalogue lookup this replaced (that used
    // to be a 6th fixed read; removing it is a net improvement, not just
    // neutral).
    const MAX_LIMIT = 40;
    const url = new URL(request.url);
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') || String(MAX_LIMIT), 10) || MAX_LIMIT, 1),
      MAX_LIMIT,
    );
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

    const rows = await getDirectory(env.GATES, { limit, offset });
    const catalogue = await getCatalogue(env.GATES);
    const byId = new Map(catalogue.map(a => [a.id, a]));

    // A glyph lookup is a KV read, and only glyph-styled avatars (tiers 1,
    // 2, 4) render a glyph at all — no-avatar, legacy release art, and
    // tier-3 duotone rows never touch the letter, so skip the read
    // entirely rather than paying for a value nothing will display.
    const GLYPH_STYLES = new Set(['glyph_solid', 'glyph_inverted', 'glyph_overlay']);
    const fans = await Promise.all(rows.map(async (r, i) => {
      const avatar = r.equipped_avatar_id ? byId.get(r.equipped_avatar_id) || null : null;
      const needsGlyph = !!avatar && GLYPH_STYLES.has(avatar.style || '');
      const glyph = needsGlyph ? await glyphLetterForEmail(env, r.email) : '';
      return { ...toPublicProfile(r, avatar, glyph), position: offset + i + 1 };
    }));

    return new Response(JSON.stringify({ fans, limit, offset, has_more: rows.length === limit }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
);
