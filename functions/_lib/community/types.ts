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
   * Set to 1 the first time the handle is regenerated off a chosen display
   * name, and never cleared. Internal state only — see toPublicProfile,
   * which is a strict allow-list and must never grow this field.
   */
  handle_locked: number;
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
}

export type UnlockRule =
  | { type: 'own_release'; slug: string }
  | { type: 'tenure_days'; days: number }
  | { type: 'free_song_streak'; weeks: number }
  | { type: 'show_attended'; showId: string }
  | { type: 'gate_completed'; gateSlug: string };

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
}

export interface UnlockGrant {
  avatarId: string;
  source: UnlockRule['type'];
  sourceRef: string | null;
}

/** Shape returned to clients. Note the absence of `email`. */
export interface PublicProfile {
  handle: string;
  display_name: string;
  fan_since: number;
  rank_points: number;
  collection_count: number;
  avatar: { id: string; name: string; art_path: string } | null;
}
