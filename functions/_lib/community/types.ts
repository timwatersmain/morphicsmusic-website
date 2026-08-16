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
   * Four-tier avatar ladder (see functions/_lib/community/glyph.ts and
   * colourways.ts). NULL for release/special rows — this is a second,
   * additive axis, not a replacement for `art_path`.
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
 * keep rendering from `art_path` as before). `glyph` is the single
 * lowercase letter this avatar's OWNER renders in tiers 1/2/4 — derived
 * server-side from that fan's private username (glyph.ts) and NEVER the
 * username itself, which must never reach a client.
 */
export interface PublicAvatar {
  id: string;
  name: string;
  art_path: string;
  style: 'glyph_solid' | 'glyph_inverted' | 'duotone' | 'glyph_overlay' | null;
  colourway: string | null;
  artwork_key: string | null;
  tier: 1 | 2 | 3 | 4 | null;
  glyph: string;
}

/** Shape returned to clients. Note the absence of `email`. */
export interface PublicProfile {
  handle: string;
  display_name: string;
  fan_since: number;
  rank_points: number;
  collection_count: number;
  avatar: PublicAvatar | null;
}
