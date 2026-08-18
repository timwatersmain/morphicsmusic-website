export interface FanProfileRow {
  id: number;
  /** Server-side only. NEVER include this in a client response. */
  email: string;
  handle: string;
  display_name: string;
  equipped_avatar_id: string | null;
  fan_since: number;
  rank_points: number;
  collection_count: number;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
  /**
   * Unix seconds of the last handle change, or null if it has never been
   * changed since profile creation. Drives the 30-day change cooldown (see
   * canChangeHandle/nextHandleChangeAt in repo.ts). Internal state only —
   * see toPublicProfile, which is a strict allow-list and must never grow
   * this field.
   */
  handle_changed_at: number | null;
  /** Evolution Points — see functions/_lib/community/ep.ts. Always >= 0. */
  ep: number;
  /**
   * NULL means "egg" — read that way by toPublicProfile, not defaulted by
   * the schema, so a pre-migration row never needs a backfill write to be
   * correct. See functions/_lib/community/ep.ts's CreatureStage. Values are
   * the sprite export's own names (egg/grub/pupa/adult) as of migration
   * 0007 — see that migration's header comment for the rename from the
   * pre-launch placeholder names.
   */
  stage: 'egg' | 'grub' | 'pupa' | 'adult' | null;
  /**
   * One sprite ref per stage (e.g. "A147"), assigned once at profile
   * creation and permanent thereafter — see
   * functions/_lib/community/sprites.ts. NULL only for a fan whose profile
   * predates migration 0007 and hasn't had a lazy backfill run yet (see
   * repo.ts's ensureSpriteAssignment).
   */
  sprite_egg: string | null;
  sprite_grub: string | null;
  sprite_pupa: string | null;
  sprite_adult: string | null;
  /**
   * The one part of the creature the fan chooses. Named key into the
   * vendored COLORWAYS (src/scripts/sprites/vendor/colorways.js), assigned
   * deterministically at creation like the sprite refs but changeable later
   * — see setCreatureColourway.
   */
  colourway: string | null;
  /** Unix seconds of the moment stage first left 'egg', or NULL pre-hatch. */
  hatched_at: number | null;
  /**
   * Admin-only permanent sprite override (migration 0008). NULL means
   * normal stage-derived rendering. When set, this ref is rendered
   * INSTEAD OF the stage-derived sprite_egg/grub/pupa/adult column,
   * everywhere the creature appears — see repo.ts's currentSpriteRef. Never
   * changes `stage` (the rank label) or `ep`/`stage_xp`. Only ever written
   * by update.ts after requireAdmin passes and sprites.ts's isValidSpriteRef
   * confirms the ref is real.
   */
  override_sprite: string | null;
  /**
   * Engagement EP bookkeeping (migration 0010) — see
   * functions/_lib/community/engagement.ts for what each field means and
   * repo.ts's getEngagementState/saveEngagementState for the read/write
   * pair. Only ever written by POST /api/community/engagement.
   */
  engagement_day: string | null;
  engagement_clicks_today: number;
  engagement_active_seconds_today: number;
  engagement_listen_xp_today: number;
  /** JSON-encoded Record<string, { played: boolean; completed: boolean }>. */
  engagement_listened_today: string;
  engagement_last_seq: number;
  /** Lifetime engagement EP — fed into ep.ts's computeEp as `engagementActions`. */
  engagement_ep: number;
  /**
   * Fan-written bio (migration 0011), or NULL if they never wrote one.
   * Sanitised and length-checked on the way in by
   * functions/_lib/community/bio.ts — never trusted raw, and never rendered
   * as HTML by any client (both surfaces set textContent, not innerHTML).
   */
  bio: string | null;
  /**
   * 0 = listed on the fan wall (the default for every existing row), 1 =
   * unlisted. "Unlisted", not "private": getDirectory skips these fans, but a
   * direct link to /community/u/<handle> still resolves for signed-in fans.
   * The copy on /community/me says exactly that, so nobody mistakes it for
   * access control.
   */
  hidden_from_wall: number;
  /**
   * NULL for a live profile. A unix timestamp means the fan deleted it and
   * it is inside the restore window (migration 0012). Every read in repo.ts
   * except isHandleTaken filters these rows out.
   */
  deleted_at?: number | null;
}

export interface AvatarCatalogueRow {
  id: string;
  kind: 'release' | 'special';
  release_slug: string | null;
  name: string;
  art_path: string;
  /** JSON-encoded UnlockRule. */
  unlock_rule: string;
  hint: string;
  available_from: number | null;
  available_until: number | null;
  sort_order: number;
  /**
   * Four-tier avatar ladder (see colourways.ts). NULL for release/special
   * rows — this is a second, additive axis, not a replacement for
   * `art_path`.
   */
  style: 'glyph_solid' | 'glyph_inverted' | 'duotone' | 'glyph_overlay' | null;
  /** Named key into COLOURWAYS (colourways.ts), never a raw hex value. */
  colourway: string | null;
  /** Filename stem under public/images/visuals/. Tiers 3-4 only. */
  artwork_key: string | null;
  /** 1-4. NULL for release/special rows. */
  tier: 1 | 2 | 3 | 4 | null;
}

export type UnlockRule =
  | { type: 'own_release'; slug: string }
  | { type: 'tenure_days'; days: number }
  | { type: 'free_song_streak'; weeks: number }
  | { type: 'show_attended'; showId: string }
  | { type: 'gate_completed'; gateSlug: string }
  // Tier 2: signup completed + a password set on the customer record.
  // Email confirmation does not exist on this site yet, so this is the
  // smallest real action available. A `played_track` rule (or similar) can
  // be added as another case here later with no migration required — the
  // rule lives in JSON, not in a column.
  | { type: 'has_password' }
  // Tiers 3-4 (duotone, glyph_overlay): granted by hand only, via
  // POST /api/admin/grant-avatar. This rule type never matches in
  // qualifies() — it exists purely so the NOT NULL unlock_rule column is
  // self-documenting, and so no future rule-engine change can accidentally
  // start auto-granting these tiers.
  | { type: 'manual' }
  // Tier 1: available to every fan from signup, by rule rather than by
  // ledger row (see update.ts's equip check on `tier === 1`). This rule
  // type also never matches in qualifies() — tier-1 rows must never be
  // written to fan_avatar_unlocks, or every fan would carry six redundant
  // ledger rows for something everyone already has.
  | { type: 'tier1_default' };

export interface UnlockContext {
  ownedSlugs: string[];
  fanSince: number;
  now: number;
  /** Consecutive weeks claiming the free song. 0 until that system ships. */
  streakWeeks: number;
  /** Show ids attended. Empty until attendance capture exists. */
  showsAttended: string[];
  /** Gate slugs completed. Empty until wired to the gate system. */
  gatesCompleted: string[];
  /** Signup completed with a password set on the customer record (tier 2). */
  hasPassword: boolean;
}

export interface UnlockGrant {
  avatarId: string;
  // UnlockRule['type'] for anything evaluateUnlocks produced, plus
  // 'admin_grant' for grants written directly by
  // POST /api/admin/grant-avatar (tiers 3-4, which never come through the
  // rule engine at all).
  source: UnlockRule['type'] | 'admin_grant';
  sourceRef: string | null;
}

/**
 * The avatar shape sent to every client — one shape used by /me, /profile
 * and /directory alike, so a single renderer (src/scripts/avatar.js)
 * handles all three. `style`/`colourway`/`artwork_key`/`tier` are the
 * tier-ladder recipe fields (null for plain release/special rows, which
 * keep rendering from `art_path` as before).
 */
export interface PublicAvatar {
  id: string;
  name: string;
  art_path: string;
  style: 'glyph_solid' | 'glyph_inverted' | 'duotone' | 'glyph_overlay' | null;
  colourway: string | null;
  artwork_key: string | null;
  tier: 1 | 2 | 3 | 4 | null;
}

/**
 * The creature shape sent to every client — same "one shape, three
 * endpoints" idea as PublicAvatar. `sprite_ref` is the ref for the fan's
 * CURRENT stage only (looked up from the per-stage columns on
 * FanProfileRow server-side — see toPublicProfile) since that's the only one
 * the renderer draws; it is null only for a legacy row that hasn't had a
 * sprite assignment backfilled yet (see repo.ts's ensureSpriteAssignment).
 * `stage_xp` is 0..100, the percentage through the current stage's EP band
 * (see ep.ts's stageXp) — this is what src/scripts/sprites feeds into the
 * vendored recipes.js's frame() so the art responds continuously to
 * progress, not just to stage changes. `next_stage_ep` is null once `stage`
 * is 'adult' — there is nowhere further to grow.
 */
export interface PublicCreature {
  stage: 'egg' | 'grub' | 'pupa' | 'adult';
  sprite_ref: string | null;
  colourway: string | null;
  ep: number;
  stage_xp: number;
  next_stage_ep: number | null;
}

/** Shape returned to clients. Note the absence of `email`. */
export interface PublicProfile {
  handle: string;
  display_name: string;
  fan_since: number;
  rank_points: number;
  collection_count: number;
  /**
   * NULL when the fan has not written one. Present on every public surface
   * (profile page, fan wall) because a bio is the point of a profile — unlike
   * `email` or `handle_changed_at`, which toPublicProfile's allow-list exists
   * to keep out.
   */
  bio: string | null;
  avatar: PublicAvatar | null;
  creature: PublicCreature;
}
