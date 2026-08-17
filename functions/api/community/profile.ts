// GET /api/community/profile?handle=<handle>
// Another fan's profile. Fans-only: signed-out callers get 401, never data.
//
// What is exposed here is exactly the spec's visible surface — display name,
// avatar, fan-since, rank, collection. Never email, prices, purchase dates or
// order history.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import {
  getProfileByHandle, getUnlockedAvatarIds, getCatalogue, getRarity, toPublicProfile,
} from '../../_lib/community/repo';
import { glyphLetterForEmail } from '../../_lib/community/glyph';

export const onRequestOptions: PagesFunction<CommunityEnv> = async ({ request }) => preflight(request);

export const onRequestGet: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(
  async ({ request, env }) => {
    const rl = await rateLimit(env, 'community_profile', 'ip', clientIp(request), 120, 60);
    if (!rl.ok) return rateLimitedJson(rl);

    if (!(await requireFan(request, env))) return unauthorized();

    const handle = (new URL(request.url).searchParams.get('handle') || '').toLowerCase();
    if (!/^[a-z0-9-]{1,32}$/.test(handle)) {
      return new Response(JSON.stringify({ error: 'bad handle' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const profile = await getProfileByHandle(env.GATES, handle);
    if (!profile) {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      });
    }

    const catalogue = await getCatalogue(env.GATES);
    const unlocked = new Set(await getUnlockedAvatarIds(env.GATES, profile.id));
    const rarity = await getRarity(env.GATES);
    const equipped = catalogue.find(a => a.id === profile.equipped_avatar_id) || null;
    // This fan's own glyph letter — one value, reused on every shelf item and
    // on the equipped avatar. Derived from their private username (never
    // sent itself); see glyphLetterForEmail's doc comment.
    const glyph = await glyphLetterForEmail(env, profile.email);

    // Only what this fan HAS. A visitor does not get to see somebody else's
    // locked list — that is the owner's to-do list, not a public fact.
    const shelf = catalogue
      .filter(a => unlocked.has(a.id))
      .map(a => ({
        id: a.id, name: a.name, art_path: a.art_path,
        kind: a.kind, release_slug: a.release_slug, rarity: rarity[a.id] ?? 0,
        // Same tier-ladder shape as toPublicProfile's avatar — see
        // PublicAvatar — so avatar.js renders shelf tiles identically to
        // the equipped avatar and the fan-wall/directory entries.
        style: a.style, colourway: a.colourway, artwork_key: a.artwork_key, tier: a.tier, glyph,
      }));

    return new Response(JSON.stringify({
      profile: { ...toPublicProfile(profile, equipped, glyph), is_self: false },
      shelf,
    }), { headers: { 'Content-Type': 'application/json' } });
  },
);
