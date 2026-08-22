// GET /api/community/me
// The signed-in fan's own profile. Creates it on first visit and runs the
// unlock engine, which is what backfills existing customers' collections.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import {
  ensureProfile, getCatalogue, getUnlockedAvatarIds, grantUnlocks,
  getDeletedProfileByEmail, purgeFanProfile, isGraceExpired, purgeDueAt, sumLedgerXp,
  getRarity, setCollectionCount, toPublicProfile, canChangeHandle, nextHandleChangeAt,
  saveCreatureProgress, ensureSpriteAssignment, getDiscordLinkByFan,
} from '../../_lib/community/repo';
import { evaluateUnlocks } from '../../_lib/community/unlocks';
import { evaluateCreature } from '../../_lib/community/creature';
import { epInputsFor, ownedSlugsFromRecord } from '../../_lib/community/ep-inputs';
import { requireAdmin } from '../../_lib/admin';
import { cycleSpan } from '../../_lib/community/ep';

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

    // Drives the admin-only sprite-override picker on /community/me (see
    // that page's script). Purely a UI-visibility hint — the actual write
    // is re-checked server-side by update.ts via the same requireAdmin, so
    // this flag alone controls nothing security-relevant.
    const isAdmin = !!(await requireAdmin(request, env));

    // Ownership and tenure still come from KV — it remains the source of truth.
    const raw = await env.DOWNLOADS.get(`customer:${email}`);
    let record: CustomerRecord = {};
    try { if (raw) record = JSON.parse(raw); } catch { /* treat as empty */ }

    const owned = ownedSlugsFromRecord(record);

    const nowSec = Math.floor(Date.now() / 1000);

    // Soft-delete gate (migration 0012). A fan sitting inside their restore
    // window must NOT be handed a shiny new profile — that would silently
    // strand the old one (the unique email index would reject the insert
    // anyway) and quietly throw away the bio and engagement EP they can
    // still get back. Instead the page is told to render the restore panel.
    //
    // A window that has already lapsed is purged right here rather than
    // waiting for the bulk sweep: this is the moment it matters, because the
    // fan is standing in front of us wanting their email and handle freed so
    // a fresh profile can be created below.
    const pendingDelete = await getDeletedProfileByEmail(env.GATES, email);
    if (pendingDelete) {
      if (isGraceExpired(pendingDelete.deleted_at ?? null, nowSec)) {
        await purgeFanProfile(env.GATES, pendingDelete.id);
      } else {
        return new Response(JSON.stringify({
          deleted: {
            handle: pendingDelete.handle,
            display_name: pendingDelete.display_name,
            deleted_at: pendingDelete.deleted_at,
            restore_until: purgeDueAt(pendingDelete.deleted_at as number),
          },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

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
    // One-time lazy backfill for a fan whose profile predates migration
    // 0007 — no-op (no extra write) for everyone assigned already. See
    // ensureSpriteAssignment's doc comment for why this lives on the
    // self-view only.
    const profileWithSprites = await ensureSpriteAssignment(env.GATES, profile);

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
    // engine above. Sprite refs/colourway are NOT re-derived here — they
    // were fixed at creation (or by ensureSpriteAssignment above); only
    // stage/ep ever change on a read.
    // Site engagement EP (clicks + active time + listening, accrued by POST
    // /api/community/engagement) plus Discord EP (accrued by POST
    // /api/discord/award) — both server-side, never client-supplied. The
    // sum and the tenure arithmetic live in ep-inputs.ts so this and the
    // Discord award path cannot rank the same fan differently.
    const discordLink = await getDiscordLinkByFan(env.GATES, profile.id);
    const discordEp = discordLink?.discord_ep || 0;
    const discordLinked = !!discordLink;
    const creatureUpdate = await evaluateCreature(
      profile,
      epInputsFor(profile, owned.size, nowSec, discordEp, await sumLedgerXp(env.GATES, profile.id)),
    );
    // hatchedAt is permanent once set, never touched again — carry the
    // existing value forward except on the exact visit that just crossed it.
    const hatchedAt = creatureUpdate.justHatched ? nowSec : profile.hatched_at;
    await saveCreatureProgress(env.GATES, profile.id, {
      ep: creatureUpdate.ep,
      stage: creatureUpdate.stage,
      hatchedAt,
    });

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
      // Tier ladder recipe fields (null for release/special rows) — same
      // shape as toPublicProfile's avatar (see PublicAvatar), so avatar.js
      // renders every avatar object on this page identically.
      style: a.style,
      colourway: a.colourway,
      artwork_key: a.artwork_key,
      tier: a.tier,
      // Tier 1 is available to everyone by rule — see update.ts's equip
      // check — so it renders as unlocked even though it never gets a
      // fan_avatar_unlocks row.
      unlocked: a.tier === 1 || unlockedIds.has(a.id),
      rarity: rarity[a.id] ?? 0,
    }));

    return new Response(JSON.stringify({
      profile: {
        ...toPublicProfile({
          ...profileWithSprites,
          collection_count: owned.size,
          ep: creatureUpdate.ep,
          stage: creatureUpdate.stage,
          prestige: creatureUpdate.prestige,
          cycle_base_ep: profile.cycle_base_ep,
          hatched_at: hatchedAt,
        }, equipped),
        is_self: true,
        // Self-view only: whether this fan has a Discord account linked.
        // Answered here rather than by a dedicated endpoint because /me is
        // already fetched on every community page, and the free plan's
        // subrequest budget is not worth spending to re-ask a question this
        // response can carry. The id itself is deliberately NOT exposed.
        discord_linked: discordLinked,
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
        // Prestige, self-view only. `can_ascend` is the button's gate; the
        // endpoint re-checks it in SQL, so this is presentation, not security.
        prestige: creatureUpdate.prestige,
        cycle_ep: creatureUpdate.cycleEp,
        cycle_span: cycleSpan(creatureUpdate.prestige),
        can_ascend: creatureUpdate.canAscend,
        // Self-view only. Verification is what grants the free track, so the
        // profile has to be able to ask for it — nothing else on the site did.
        email_verified: !!(record as any)?.email_verified_at,
        ascended_at: profile.ascended_at ?? null,
        // Self-view only augmentation, same pattern as can_change_handle —
        // toPublicProfile's allow-list stays untouched by this feature.
        // is_admin gates the picker's visibility client-side; the actual
        // write is re-gated server-side by update.ts regardless of what a
        // client sends. override_sprite is surfaced raw (not folded into
        // creature.sprite_ref, which already reflects it via
        // toPublicProfile) so the picker can highlight the current
        // selection without re-deriving it.
        is_admin: isAdmin,
        override_sprite: profile.override_sprite,
        // Self-view only, same pattern as can_change_handle: `bio` is already
        // public (see toPublicProfile), but the wall-visibility switch is a
        // setting, not a fact about the fan, and nobody else's copy of it is
        // any of their business. Sent as a boolean rather than the raw 0/1
        // column so the toggle binds to it directly.
        hidden_from_wall: !!profile.hidden_from_wall,
      },
      avatars,
      newly_unlocked: grants.filter(g => !heldBefore.has(g.avatarId)).map(g => g.avatarId),
    }), { headers: { 'Content-Type': 'application/json' } });
  },
);
