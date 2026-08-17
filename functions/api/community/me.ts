// GET /api/community/me
// The signed-in fan's own profile. Creates it on first visit and runs the
// unlock engine, which is what backfills existing customers' collections.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import {
  ensureProfile, getCatalogue, getUnlockedAvatarIds, grantUnlocks,
  getRarity, setCollectionCount, toPublicProfile, canChangeHandle, nextHandleChangeAt,
  getSpeciesCatalogue, saveCreatureProgress,
} from '../../_lib/community/repo';
import { evaluateUnlocks } from '../../_lib/community/unlocks';
import { evaluateCreature } from '../../_lib/community/creature';
import { glyphLetterFor } from '../../_lib/community/glyph';

interface CustomerRecord {
  // Deliberately no `name` field: the KV record's `name` is the Stripe
  // cardholder's legal name and must never be read into a fan-facing field.
  // See the comment on `displayName: null` below.
  first_seen_at?: number;
  purchases?: Array<{ music_release_slugs?: string[]; digital_slugs?: string[] }>;
  // The login username, if this customer has an account (functions/api/auth/
  // signup.ts). Unlike `name`, this IS fan-chosen and safe to seed the
  // profile with — see the `username` comment below.
  username?: string;
  // Presence (not value) drives tier 2's has_password unlock rule — see
  // functions/_lib/customer.ts's CustomerRecord.password.
  password?: string;
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
      // `record.name` is the Stripe cardholder's LEGAL NAME
      // (customer_details.name) — never persist it as a display name or let
      // it seed a handle.
      displayName: null,
      // Username and handle are separate things, but the handle defaults to
      // the username: a fan with a login already has a name they chose
      // themselves, so there is no reason to hand them a placeholder handle
      // like "fan-7" first. Purchase-only customers with no username fall
      // back to ensureProfile's 'Fan' default and can set a real handle
      // later via /api/community/update.
      username: record.username || null,
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
        // Tier 2's has_password rule. Presence, not value — the hash itself
        // never leaves this scope.
        hasPassword: !!record.password,
      },
      catalogue,
    );
    await grantUnlocks(env.GATES, profile.id, grants);
    await setCollectionCount(env.GATES, profile.id, owned.size);

    // Visiting your own profile is what advances your creature — this runs
    // on every /me read, same idempotent-on-every-visit shape as the unlock
    // engine above. See evaluateCreature: stage never regresses and species
    // is assigned once, permanently, at the moment stage first leaves 'egg'.
    const speciesRoster = await getSpeciesCatalogue(env.GATES);
    const tenureDays = Math.max(0, (nowSec - profile.fan_since) / 86400);
    const creatureUpdate = await evaluateCreature(
      profile,
      { purchaseCount: owned.size, tenureDays, engagementActions: 0 },
      speciesRoster,
      nowSec,
    );
    await saveCreatureProgress(env.GATES, profile.id, {
      ep: creatureUpdate.ep,
      stage: creatureUpdate.stage,
      species: creatureUpdate.species,
      hatchedAt: creatureUpdate.hatchedAt,
    });
    const speciesRow = creatureUpdate.species
      ? speciesRoster.find(s => s.id === creatureUpdate.species) || null
      : null;

    const unlockedIds = new Set(await getUnlockedAvatarIds(env.GATES, profile.id));
    const rarity = await getRarity(env.GATES);
    const equipped = catalogue.find(a => a.id === profile.equipped_avatar_id) || null;
    // Already have `record` in scope (no extra KV read needed here, unlike
    // glyphLetterForEmail which other endpoints use for a fan they haven't
    // otherwise loaded). Same fallback as a purchase-only customer with no
    // username: glyphLetterFor('') lands on the house letter.
    const glyph = glyphLetterFor(record.username || '');

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
      // Tier ladder recipe fields (null for release/special rows). `glyph`
      // is this fan's own letter, derived server-side from their private
      // username and never the username itself — same shape as
      // toPublicProfile's avatar (see PublicAvatar), so avatar.js renders
      // every avatar object on this page identically.
      style: a.style,
      colourway: a.colourway,
      artwork_key: a.artwork_key,
      tier: a.tier,
      glyph,
      // Tier 1 is available to everyone by rule — see update.ts's equip
      // check — so it renders as unlocked even though it never gets a
      // fan_avatar_unlocks row.
      unlocked: a.tier === 1 || unlockedIds.has(a.id),
      rarity: rarity[a.id] ?? 0,
    }));

    return new Response(JSON.stringify({
      profile: {
        ...toPublicProfile({
          ...profile,
          collection_count: owned.size,
          ep: creatureUpdate.ep,
          stage: creatureUpdate.stage,
          species: creatureUpdate.species,
          hatched_at: creatureUpdate.hatchedAt,
        }, equipped, glyph, speciesRow),
        is_self: true,
        // Self-view only augmentation (not part of toPublicProfile's public
        // allow-list) so the settings UI can tell the fan when they'll next
        // be able to change their handle, without exposing the raw
        // handle_changed_at timestamp itself.
        can_change_handle: canChangeHandle(profile.handle_changed_at, nowSec),
        handle_change_available_at: profile.handle_changed_at === null
          ? null
          : nextHandleChangeAt(profile.handle_changed_at),
        // Self-view only, same reasoning as can_change_handle above — lets
        // the UI show a one-time hatch celebration on the visit that caused it.
        just_hatched: creatureUpdate.justHatched,
      },
      avatars,
      newly_unlocked: grants.filter(g => !heldBefore.has(g.avatarId)).map(g => g.avatarId),
    }), { headers: { 'Content-Type': 'application/json' } });
  },
);
