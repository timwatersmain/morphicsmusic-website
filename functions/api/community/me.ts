// GET /api/community/me
// The signed-in fan's own profile. Creates it on first visit and runs the
// unlock engine, which is what backfills existing customers' collections.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import {
  ensureProfile, getCatalogue, getUnlockedAvatarIds, grantUnlocks,
  getRarity, setCollectionCount, toPublicProfile,
} from '../../_lib/community/repo';
import { evaluateUnlocks } from '../../_lib/community/unlocks';

interface CustomerRecord {
  name?: string | null;
  first_seen_at?: number;
  purchases?: Array<{ music_release_slugs?: string[]; digital_slugs?: string[] }>;
}

export const onRequestOptions: PagesFunction<CommunityEnv> = async ({ request }) => preflight(request);

export const onRequestGet: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(
  async ({ request, env }) => {
    const rl = await rateLimit(env, 'community_me', 'ip', clientIp(request), 60, 60);
    if (!rl.ok) return rateLimitedJson(rl);

    const email = await requireFan(request, env);
    if (!email) return unauthorized();

    // Ownership and tenure still come from KV — it remains the source of truth.
    const raw = await env.DOWNLOADS.get(`customer:${email}`);
    let record: CustomerRecord = {};
    try { if (raw) record = JSON.parse(raw); } catch { /* treat as empty */ }

    const owned = new Set<string>();
    for (const p of record.purchases || []) {
      for (const s of p.music_release_slugs || []) owned.add(s);
      for (const d of p.digital_slugs || []) owned.add(d);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const profile = await ensureProfile(env.GATES, {
      email,
      // A fan with no purchases (e.g. arrived via a download gate) still gets
      // a profile; their tenure starts now.
      fanSince: record.first_seen_at || nowSec,
      displayName: record.name || null,
    });

    const catalogue = await getCatalogue(env.GATES);
    // Read the shelf BEFORE granting. Reading it afterwards would already
    // include the new grants, so "what did you just earn" would always be
    // empty — and that moment is the whole point of the reward loop.
    const heldBefore = new Set(await getUnlockedAvatarIds(env.GATES, profile.id));
    const grants = evaluateUnlocks(
      {
        ownedSlugs: [...owned],
        fanSince: profile.fan_since,
        now: nowSec,
        // Zero until the free-song, shows and gate systems ship. Their avatars
        // exist in the catalogue and render locked with their hint.
        streakWeeks: 0,
        showsAttended: [],
        gatesCompleted: [],
      },
      catalogue,
    );
    await grantUnlocks(env.GATES, profile.id, grants);
    await setCollectionCount(env.GATES, profile.id, owned.size);

    const unlockedIds = new Set(await getUnlockedAvatarIds(env.GATES, profile.id));
    const rarity = await getRarity(env.GATES);
    const equipped = catalogue.find(a => a.id === profile.equipped_avatar_id) || null;

    // The owner sees the whole catalogue: unlocked ones to equip, locked ones
    // with their hint. The locked half is the entire point — an unseen reward
    // motivates nobody.
    const avatars = catalogue.map(a => ({
      id: a.id,
      name: a.name,
      art_path: a.art_path,
      hint: a.hint,
      kind: a.kind,
      release_slug: a.release_slug,
      unlocked: unlockedIds.has(a.id),
      rarity: rarity[a.id] ?? 0,
    }));

    return new Response(JSON.stringify({
      profile: { ...toPublicProfile({ ...profile, collection_count: owned.size }, equipped), is_self: true },
      avatars,
      newly_unlocked: grants.filter(g => !heldBefore.has(g.avatarId)).map(g => g.avatarId),
    }), { headers: { 'Content-Type': 'application/json' } });
  },
);
