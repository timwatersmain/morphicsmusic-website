// GET /api/community/directory?limit=&offset=
// The fan wall: directory + leaderboard, in one paginated list.
// Answers spec open question §10.3 — it paginates, defaulting to 40 a page
// (see MAX_LIMIT below — the subrequest budget caps it there).

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import { getDirectory, getCatalogue, getSpeciesCatalogue, toPublicProfile } from '../../_lib/community/repo';
import { glyphLetterForEmail } from '../../_lib/community/glyph';

export const onRequestOptions: PagesFunction<CommunityEnv> = async ({ request }) => preflight(request);

export const onRequestGet: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(
  async ({ request, env }) => {
    const rl = await rateLimit(env, 'community_dir', 'ip', clientIp(request), 60, 60);
    if (!rl.ok) return rateLimitedJson(rl);

    if (!(await requireFan(request, env))) return unauthorized();

    // Cloudflare Free caps a single request at 50 subrequests, and every
    // glyph lookup below is a KV get — one per fan on the page. This
    // endpoint spends 6 fixed subrequests (rate-limit get+put, session-
    // version get, getDirectory, getCatalogue, getSpeciesCatalogue — the
    // last of those is new, but it is ONE read for the whole page, not
    // per-row, exactly like getCatalogue; creature fields must never grow
    // into a per-fan KV read), so the page size must stay well under 50
    // even in the worst case where every fan on the page wears a glyph avatar
    // (6 fixed + 40 glyph KV reads = 46, still under the cap).
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
    // One extra D1 read for the WHOLE page, not per-row — the species
    // roster is small and fetched once, same shape as `catalogue` above.
    // This must never become a per-fan KV read (see the subrequest budget
    // note below the glyph lookup).
    const speciesCatalogue = await getSpeciesCatalogue(env.GATES);
    const speciesById = new Map(speciesCatalogue.map(s => [s.id, s]));

    // A glyph lookup is a KV read, and only glyph-styled avatars (tiers 1,
    // 2, 4) render a glyph at all — no-avatar, legacy release art, and
    // tier-3 duotone rows never touch the letter, so skip the read
    // entirely rather than paying for a value nothing will display.
    const GLYPH_STYLES = new Set(['glyph_solid', 'glyph_inverted', 'glyph_overlay']);
    const fans = await Promise.all(rows.map(async (r, i) => {
      const avatar = r.equipped_avatar_id ? byId.get(r.equipped_avatar_id) || null : null;
      const needsGlyph = !!avatar && GLYPH_STYLES.has(avatar.style || '');
      const glyph = needsGlyph ? await glyphLetterForEmail(env, r.email) : '';
      const speciesRow = r.species ? speciesById.get(r.species) || null : null;
      return { ...toPublicProfile(r, avatar, glyph, speciesRow), position: offset + i + 1 };
    }));

    return new Response(JSON.stringify({ fans, limit, offset, has_more: rows.length === limit }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
);
