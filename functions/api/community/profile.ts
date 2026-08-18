// GET /api/community/profile?handle=<handle>
// Another fan's profile. Fans-only: signed-out callers get 401, never data.
//
// What is exposed here is exactly the visible surface of a profile — display
// name, avatar, fan-since, rank and the fan's own bio. Never email, prices,
// purchase dates or order history.
//
// The avatar COLLECTION used to ship here as `shelf`. It no longer does: a
// profile is a person, not a trophy case, and the shelf was the whole page
// for a visitor. Nothing about the underlying unlock ledger changed — the
// rows, the grants and the rarity maths are all still there, they are simply
// not what somebody else's profile is about. The rank ladder (see ep.ts's
// STAGE_LABELS) is what a visitor reads for standing now.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import {
  getProfileByHandle, getProfileByEmail, getCatalogue, toPublicProfile,
} from '../../_lib/community/repo';

export const onRequestOptions: PagesFunction<CommunityEnv> = async ({ request }) => preflight(request);

export const onRequestGet: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(
  async ({ request, env }) => {
    const rl = await rateLimit(env, 'community_profile', 'ip', clientIp(request), 120, 60);
    if (!rl.ok) return rateLimitedJson(rl);

    const email = await requireFan(request, env);
    if (!email) return unauthorized();

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

    // Still read for the EQUIPPED avatar only — one row out of the catalogue,
    // not the fan's unlock ledger. Dropping the shelf also dropped two
    // subrequests per call (getUnlockedAvatarIds and the whole-table rarity
    // scan), which is real budget back on a page that is one D1 read away
    // from Cloudflare's Free-tier subrequest cap.
    const catalogue = await getCatalogue(env.GATES);
    const equipped = catalogue.find(a => a.id === profile.equipped_avatar_id) || null;

    // `is_self` lets the page offer "edit your profile" to the one visitor
    // who can act on it, without a second round trip to /api/community/me.
    const viewer = await getProfileByEmail(env.GATES, email);

    return new Response(JSON.stringify({
      profile: {
        ...toPublicProfile(profile, equipped),
        is_self: !!viewer && viewer.id === profile.id,
      },
    }), { headers: { 'Content-Type': 'application/json' } });
  },
);
