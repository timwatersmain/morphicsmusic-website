// Row types for the download gate tables (migrations/0001_download_gates.sql)
// plus the contact fields the gate adds to the EXISTING customer record.
//
// Nothing here queries anything — it is the shared vocabulary for Phases 2-7.

// ── Verification vocabulary ─────────────────────────────────────────────

/**
 * How an action was satisfied.
 *
 *  - 'verified'  the server confirmed the action actually happened, against
 *                the platform's own API, for this specific visitor.
 *  - 'attested'  the visitor was sent to the target and came back. We have no
 *                proof. This is an honest label, not a weaker synonym for
 *                verified, and it is what gets stored, displayed and exported.
 *
 * These two strings are the only permitted values in
 * gate_actions.verification_mode and gate_action_completions
 * .verification_mode_used, enforced by CHECK constraints in the migration.
 */
export type VerificationMode = 'verified' | 'attested';

/**
 * The action types that can genuinely be checked server-side.
 *
 * Kept in sync with the CHECK constraint in 0001_download_gates.sql. Adding a
 * type here without also changing that constraint will simply fail the insert,
 * which is the intended direction of failure.
 */
export const VERIFIABLE_ACTION_TYPES = [
  'soundcloud_follow',
  'soundcloud_like',
  'soundcloud_repost',
  'soundcloud_comment',
  'email',
] as const;

/**
 * Everything else. No public API answers "did this visitor follow me" for any
 * of these.
 *
 * Spotify is on this list permanently and deliberately: the Web API endpoints
 * that would answer it require Extended Quota Mode, which needs roughly 250k
 * monthly active users and an established business entity. An independent
 * artist will not be approved, so no Spotify follow check exists in this
 * codebase and none should be added.
 */
export const ATTESTED_ONLY_ACTION_TYPES = [
  'spotify_follow',
  'spotify_save',
  'instagram_follow',
  'tiktok_follow',
  'youtube_subscribe',
  'bandcamp_follow',
  'facebook_follow',
  'x_follow',
  'visit_link',
] as const;

export type VerifiableActionType = (typeof VERIFIABLE_ACTION_TYPES)[number];
export type AttestedOnlyActionType = (typeof ATTESTED_ONLY_ACTION_TYPES)[number];
export type GateActionType = VerifiableActionType | AttestedOnlyActionType;

/** Mirrors the DB CHECK, so callers can fail early with a useful message. */
export function canBeVerified(type: string): type is VerifiableActionType {
  return (VERIFIABLE_ACTION_TYPES as readonly string[]).includes(type);
}

/**
 * The mode an action is actually allowed to run in. Anything not verifiable
 * is forced to 'attested' regardless of what the caller asked for — the DB
 * would reject it anyway, this just makes the failure legible.
 */
export function resolveVerificationMode(
  type: string,
  requested: VerificationMode,
): VerificationMode {
  return requested === 'verified' && canBeVerified(type) ? 'verified' : 'attested';
}

// ── Table rows ──────────────────────────────────────────────────────────

export interface GateRow {
  id: number;
  slug: string;
  title: string;
  subtitle: string | null;
  artwork_path: string | null;
  preview_audio_path: string | null;
  /** R2 key under the `gates/` prefix. The delivery allow-list. */
  file_storage_key: string;
  file_label: string | null;
  file_size_bytes: number | null;
  /** 0 | 1 */
  active: number;
  published_at: number | null;
  expires_at: number | null;
  /** JSON string, or null to inherit the site theme. */
  theme_overrides: string | null;
  created_at: number;
  updated_at: number;
}

export interface GateActionRow {
  id: number;
  gate_id: number;
  ordinal: number;
  type: GateActionType;
  target_url: string | null;
  /** SoundCloud URN or numeric id — TEXT, because SoundCloud is migrating to URNs. */
  target_resource_id: string | null;
  verification_mode: VerificationMode;
  label: string | null;
  /** 0 | 1 */
  required: number;
  created_at: number;
}

export interface GateUnlockRow {
  id: number;
  gate_id: number;
  /** KV key of the customer record (`customer:<email>`), or null if none yet. */
  customer_key: string | null;
  email: string;
  /** Double opt-in. Null until the confirmation link is clicked. */
  email_confirmed_at: number | null;
  ip_hash: string | null;
  user_agent_hash: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  referrer: string | null;
  marketing_consent_at: number | null;
  consent_text_snapshot: string | null;
  completed_at: number | null;
  download_count: number;
  created_at: number;
}

export interface GateActionCompletionRow {
  id: number;
  unlock_id: number;
  action_id: number;
  /** What actually happened — written from the verifier result, never from config. */
  verification_mode_used: VerificationMode;
  verified_at: number;
  /** JSON string of the evidence the verifier saw. */
  raw_evidence: string | null;
}

export type GateEventType =
  | 'gate_view'
  | 'action_started'
  | 'action_completed'
  | 'action_failed'
  | 'email_submitted'
  | 'email_confirmed'
  | 'unlock_completed'
  | 'download_delivered';

export interface GateEventRow {
  id: number;
  gate_id: number;
  unlock_id: number | null;
  action_id: number | null;
  type: GateEventType;
  detail: string | null;
  ip_hash: string | null;
  created_at: number;
}

// ── Contact fields on the EXISTING customer record ──────────────────────

/**
 * The brief's `contacts` table. There is deliberately no such table.
 *
 * This site already has exactly one identity record — the KV entry
 * `customer:<email>`, written by recordCustomerPurchase() in
 * functions/api/stripe-webhook.ts:141 — and creating a second one would split
 * the truth about who a person is. So the contact fields are added to that
 * record instead, and D1 holds only gate *events* that reference it by email.
 *
 * These fields are all optional, so every record written before the gate
 * existed stays valid and no reader needs changing.
 */
export interface ContactFields {
  /** Slug of the gate this person first arrived through. Never overwritten. */
  source_gate_slug?: string;
  /** Unix seconds when the marketing box was ticked. Absent = no consent. */
  marketing_consent_at?: number;
  /** Exact wording shown on screen at that moment. */
  consent_text_snapshot?: string;
  /** Free-form labels for segmentation, e.g. ['gate:acid-pack', 'soundcloud']. */
  tags?: string[];
}

/**
 * A purchase entry recorded for a free gate unlock.
 *
 * Shaped like the existing CustomerPurchase (stripe-webhook.ts:121) so
 * /api/library and the cookie-auth download path in
 * functions/api/download.ts:122 pick it up with no change at all. The
 * `source` marker is what keeps a freebie claimer distinguishable from a
 * paying customer forever — nothing should ever export a gate claimer as a
 * buyer.
 */
export interface GateGrantEntry {
  purchased_at: number;
  /** Always 0. A gate item is free. */
  amount_total: 0;
  currency: 'usd';
  /** `gate:<slug>` — the marker that separates these from real purchases. */
  source: string;
  /** No Stripe session exists for a gate unlock. */
  stripe_session_id: null;
  music_release_slugs: string[];
  digital_slugs: string[];
  merch_items: never[];
  /** R2 keys granted by this unlock. */
  gate_file_keys: string[];
}

/** True if a purchase entry came from a gate rather than a real payment. */
export function isGateGrant(entry: { source?: string | null }): boolean {
  return typeof entry?.source === 'string' && entry.source.startsWith('gate:');
}
