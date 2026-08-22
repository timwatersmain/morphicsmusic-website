// All D1 access for the community feature. Every function takes the database
// as its first argument so tests can inject a node:sqlite shim.

import { nextAvailableHandle, isValidDisplayName, isBlockedName } from './handle';
import type {
  AvatarCatalogueRow, FanProfileRow, PublicProfile, UnlockGrant,
} from './types';
import { nextStageThreshold, stageXp, type CreatureStage } from './ep';
import { assignSpriteRefs } from './sprites';
import type { EngagementState, ListenFlags } from './engagement';

const now = () => Math.floor(Date.now() / 1000);

// A fan may change their handle, but not more than once every 30 days —
// keeps profile links reasonably stable and makes name-squatting expensive,
// without freezing anyone out of their own name forever (the old
// handle_locked model this replaces).
export const HANDLE_CHANGE_COOLDOWN_DAYS = 30;
const HANDLE_CHANGE_COOLDOWN_SECONDS = HANDLE_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60;

// Deleting a profile is a soft delete (migration 0012): the row is hidden
// from every surface at once but survives for this long, so an accidental
// deletion is a support-free, self-serve undo rather than an unrecoverable
// loss of a bio and months of engagement EP.
//
// EVERY read in this file except isHandleTaken filters `deleted_at IS NULL`.
// That is the invariant the whole feature rests on: a soft-deleted profile
// must be indistinguishable from a hard-deleted one everywhere a fan (or
// anyone else) can see, or "deleted" is a lie. isHandleTaken is the single
// deliberate exception — see its doc comment.
export const DELETE_GRACE_DAYS = 30;
const DELETE_GRACE_SECONDS = DELETE_GRACE_DAYS * 24 * 60 * 60;

/** When a profile soft-deleted at `deletedAt` becomes eligible for hard deletion. */
export function purgeDueAt(deletedAt: number): number {
  return deletedAt + DELETE_GRACE_SECONDS;
}

/** Has the grace window run out? Exclusive of the boundary second — a fan restoring at the exact tick still wins. */
export function isGraceExpired(deletedAt: number | null, now: number): boolean {
  if (deletedAt === null || deletedAt === undefined) return false;
  return now > purgeDueAt(deletedAt);
}

/**
 * Whether the fan may change their handle right now. `handleChangedAt` null
 * means "never changed" — always permitted. `now` is injected (unix
 * seconds) so this stays a pure function callers can test without faking
 * the system clock.
 */
export function canChangeHandle(handleChangedAt: number | null, now: number): boolean {
  if (handleChangedAt === null) return true;
  return now - handleChangedAt >= HANDLE_CHANGE_COOLDOWN_SECONDS;
}

/** Unix seconds at which the cooldown lifts. Only meaningful when canChangeHandle is false. */
export function nextHandleChangeAt(handleChangedAt: number): number {
  return handleChangedAt + HANDLE_CHANGE_COOLDOWN_SECONDS;
}

export async function getProfileByHandle(
  db: D1Database, handle: string,
): Promise<FanProfileRow | null> {
  return db.prepare('SELECT * FROM fan_profiles WHERE handle = ? AND deleted_at IS NULL')
    .bind(handle).first<FanProfileRow>();
}

export async function getProfileByEmail(
  db: D1Database, email: string,
): Promise<FanProfileRow | null> {
  return db.prepare('SELECT * FROM fan_profiles WHERE email = ? AND deleted_at IS NULL')
    .bind(email.toLowerCase().trim()).first<FanProfileRow>();
}

/**
 * By primary key — the lookup the Discord award path needs, since a
 * discord_links row identifies its fan by id and nothing else. Excludes
 * soft-deleted profiles like every other getter here, so a fan who deleted
 * their account stops earning even if the link row outlives them.
 */
export async function getProfileById(
  db: D1Database, id: number,
): Promise<FanProfileRow | null> {
  return db.prepare('SELECT * FROM fan_profiles WHERE id = ? AND deleted_at IS NULL')
    .bind(id).first<FanProfileRow>();
}

/**
 * The soft-deleted profile for this email, if one is pending purge. The ONLY
 * read that returns a deleted row, and it exists for exactly one caller:
 * /api/community/me, which has to tell a returning fan "your profile is
 * deleted, restore it or discard it" rather than silently building them a
 * new one on top of the old row (which the unique email index would reject
 * anyway).
 */
export async function getDeletedProfileByEmail(
  db: D1Database, email: string,
): Promise<FanProfileRow | null> {
  return db.prepare('SELECT * FROM fan_profiles WHERE email = ? AND deleted_at IS NOT NULL')
    .bind(email.toLowerCase().trim()).first<FanProfileRow>();
}

/**
 * Handle availability, counting soft-deleted profiles as TAKEN. This is the
 * one read here that does not filter them out, and the asymmetry is the
 * point: a handle stays reserved for its owner's whole restore window. If it
 * did not, a fan could restore into a unique-index violation, or — worse —
 * an old link could quietly resolve to whoever grabbed the name in between.
 */
export async function isHandleTaken(db: D1Database, handle: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS x FROM fan_profiles WHERE handle = ?')
    .bind(handle).first<{ x: number }>();
  return !!row;
}

/**
 * Fetch the fan's profile, creating it if this is their first visit.
 *
 * `displayName`/`username` are only used at creation — they never overwrite
 * a name or handle the fan has since chosen. Username and handle are
 * separate concepts, but the handle defaults to the username when one
 * exists (accounts created after username/password auth shipped); customers
 * who signed up before that existed (purchase-only, no username) fall back
 * to the display-name-derived behaviour this always had. Neither is ever
 * derived from the email, which must not leak into a fan-facing identifier.
 */
export async function ensureProfile(
  db: D1Database,
  opts: { email: string; fanSince: number; displayName?: string | null; username?: string | null },
): Promise<FanProfileRow> {
  const email = opts.email.toLowerCase().trim();
  const existing = await getProfileByEmail(db, email);
  if (existing) return existing;

  // Defence in depth: update.ts is the normal path that enforces
  // isBlockedName, but a seeded/imported displayName/username should never
  // be able to slip a reserved word (e.g. "admin") straight into a handle
  // either.
  const rawName = opts.username || opts.displayName || '';
  const name = (isValidDisplayName(rawName) && !isBlockedName(rawName)) ? rawName.trim() : 'Fan';
  // Route the username case through nextAvailableHandle too: slugifyHandle
  // collapses underscores to hyphens, so two DISTINCT usernames like
  // "foo_bar" and "foo-bar" slugify to the same root "foo-bar" — the second
  // account to arrive must get a suffixed handle instead of colliding.
  // isHandleTaken, NOT getProfileByHandle: a handle held by a profile inside
  // its restore window is unavailable, even though that profile is invisible.
  const handle = await nextAvailableHandle(name, h => isHandleTaken(db, h));
  const t = now();

  // Sprite refs (one per stage) and colourway are fixed HERE, at creation —
  // never re-rolled, never assigned lazily on a "hatch" moment like the
  // retired species model. See sprites.ts's module doc comment.
  const sprites = await assignSpriteRefs(email);

  try {
    await db.prepare(
      `INSERT INTO fan_profiles
         (email, handle, display_name, fan_since, created_at, updated_at, last_seen_at,
          sprite_egg, sprite_grub, sprite_pupa, sprite_adult, colourway)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      email, handle, name, opts.fanSince, t, t, t,
      sprites.sprite_egg, sprites.sprite_grub, sprites.sprite_pupa, sprites.sprite_adult, sprites.colourway,
    ).run();
  } catch (err) {
    // A concurrent request created this profile between our read above and
    // this insert. The unique index on email makes that insert THROW — it
    // does not fail silently — so the recovery has to live in a catch. Their
    // row stands; return it. If no row is there, the error was something
    // else entirely and must not be swallowed.
    const raced = await getProfileByEmail(db, email);
    if (raced) return raced;
    throw err;
  }

  const created = await getProfileByEmail(db, email);
  if (!created) throw new Error('profile creation failed');
  return created;
}

/** Insert grants, ignoring ones already held. Returns how many were new. */
export async function grantUnlocks(
  db: D1Database, fanId: number, grants: UnlockGrant[],
): Promise<number> {
  if (!grants.length) return 0;
  const held = new Set(await getUnlockedAvatarIds(db, fanId));
  const fresh = grants.filter(g => !held.has(g.avatarId));
  if (!fresh.length) return 0;
  const t = now();
  for (const g of fresh) {
    // ON CONFLICT DO NOTHING makes this safe against a concurrent grant too —
    // the pre-filter above is an optimisation, not the correctness guarantee.
    await db.prepare(
      `INSERT INTO fan_avatar_unlocks (fan_id, avatar_id, unlocked_at, source, source_ref)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (fan_id, avatar_id) DO NOTHING`,
    ).bind(fanId, g.avatarId, t, g.source, g.sourceRef).run();
  }
  return fresh.length;
}

export async function getUnlockedAvatarIds(db: D1Database, fanId: number): Promise<string[]> {
  const { results } = await db.prepare(
    'SELECT avatar_id FROM fan_avatar_unlocks WHERE fan_id = ? ORDER BY unlocked_at',
  ).bind(fanId).all<{ avatar_id: string }>();
  return (results || []).map(r => r.avatar_id);
}

export async function getCatalogue(db: D1Database): Promise<AvatarCatalogueRow[]> {
  const { results } = await db.prepare(
    'SELECT * FROM avatar_catalogue ORDER BY sort_order, id',
  ).all<AvatarCatalogueRow>();
  return results || [];
}

export async function getAvatarById(db: D1Database, id: string): Promise<AvatarCatalogueRow | null> {
  return db.prepare('SELECT * FROM avatar_catalogue WHERE id = ?').bind(id).first<AvatarCatalogueRow>();
}

/**
 * Revoke a single grant (admin-only tiers 3-4). No-op if the fan never held
 * it. Does not touch `equipped_avatar_id` — a fan wearing a revoked avatar
 * falls back to the default render on next profile read, same as any other
 * avatar deleted out from under them (see the ON DELETE SET NULL fk).
 */
export async function revokeUnlock(db: D1Database, fanId: number, avatarId: string): Promise<void> {
  await db.prepare('DELETE FROM fan_avatar_unlocks WHERE fan_id = ? AND avatar_id = ?')
    .bind(fanId, avatarId).run();
  // A fan wearing the avatar being revoked must not keep displaying
  // something they no longer hold — the fk's ON DELETE SET NULL only fires
  // when the catalogue row itself is deleted, not when just the ledger
  // entry is, so that has to be handled explicitly here.
  await db.prepare(
    'UPDATE fan_profiles SET equipped_avatar_id = NULL WHERE id = ? AND equipped_avatar_id = ?',
  ).bind(fanId, avatarId).run();
}

/** avatarId -> fraction of all fans holding it (0..1). Empty when no fans. */
export async function getRarity(db: D1Database): Promise<Record<string, number>> {
  const total = await db.prepare('SELECT COUNT(*) AS c FROM fan_profiles WHERE deleted_at IS NULL')
    .first<{ c: number }>();
  const fans = total?.c || 0;
  if (!fans) return {};
  // The JOIN is what keeps this consistent with the denominator above.
  // softDeleteFanProfile deliberately KEEPS the unlock ledger (so a restore
  // hands back a full shelf), so counting fan_avatar_unlocks on its own
  // would count holders who are not live fans — and a fraction with a
  // denominator that excludes them and a numerator that doesn't can exceed 1.
  const { results } = await db.prepare(
    `SELECT u.avatar_id AS avatar_id, COUNT(*) AS c
       FROM fan_avatar_unlocks u
       JOIN fan_profiles fp ON fp.id = u.fan_id
      WHERE fp.deleted_at IS NULL
      GROUP BY u.avatar_id`,
  ).all<{ avatar_id: string; c: number }>();
  const out: Record<string, number> = {};
  for (const r of results || []) out[r.avatar_id] = r.c / fans;
  return out;
}

/**
 * Directory page. Matches the copy on /community — "ranked by rarity and
 * tenure" — by ordering on the number of avatars each fan has actually
 * unlocked (descending), then tenure (ascending) as the tiebreaker.
 * `rank_points` is a placeholder column (always 0) until the loyalty
 * sub-project lands, so it cannot be the sort key yet.
 */
export async function getDirectory(
  db: D1Database, opts: { limit: number; offset: number },
): Promise<FanProfileRow[]> {
  const limit = Math.min(Math.max(opts.limit | 0, 1), 100);
  const offset = Math.max(opts.offset | 0, 0);
  // hidden_from_wall = 0 filters out fans who opted out of the wall
  // (migration 0011); deleted_at IS NULL drops profiles inside their delete
  // grace window (migration 0012) — a fan who asked to be deleted must not
  // still be standing on the wall while they think about it. WHERE, not a
  // post-filter in the caller: filtering after
  // the LIMIT would silently shrink pages to fewer than `limit` rows and make
  // has_more lie about whether another page exists.
  const { results } = await db.prepare(
    `SELECT fp.*, COUNT(u.avatar_id) AS unlock_count
       FROM fan_profiles fp
       LEFT JOIN fan_avatar_unlocks u ON u.fan_id = fp.id
       WHERE fp.hidden_from_wall = 0 AND fp.deleted_at IS NULL
       GROUP BY fp.id
       -- Most recently active first. It was unlock_count DESC, which ranked
       -- the wall by collection size and left it looking frozen: the same
       -- people at the top for months, and a fan who signed in today buried
       -- behind whoever happened to own the most avatars. NULLs last so a
       -- profile that predates last_seen_at tracking does not sort above
       -- everyone (NULL is lower than any integer in SQLite's ordering).
       ORDER BY (fp.last_seen_at IS NULL), fp.last_seen_at DESC, fp.fan_since ASC
       LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<FanProfileRow>();
  return results || [];
}

/**
 * How many profiles the directory would page through. Its WHERE clause has to
 * stay identical to getDirectory's or the page count is a lie — a member
 * hidden from the wall must not be counted into a page that will never show
 * them.
 */
export async function countDirectory(db: D1Database): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n
       FROM fan_profiles fp
       WHERE fp.hidden_from_wall = 0 AND fp.deleted_at IS NULL`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

function buildProfileSets(
  fields: {
    displayName?: string; equippedAvatarId?: string | null; overrideSprite?: string | null;
    bio?: string | null; hiddenFromWall?: boolean;
  },
  handle: string | undefined,
  t: number,
): { sets: string[]; args: unknown[] } {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (fields.displayName !== undefined) { sets.push('display_name = ?'); args.push(fields.displayName); }
  // Already sanitised and length-checked by update.ts via bio.ts — this
  // function trusts its caller, same as every other field here. null is a
  // real value (the fan cleared their bio), never "leave unchanged": that
  // distinction is carried by undefined.
  if (fields.bio !== undefined) { sets.push('bio = ?'); args.push(fields.bio); }
  if (fields.hiddenFromWall !== undefined) {
    sets.push('hidden_from_wall = ?'); args.push(fields.hiddenFromWall ? 1 : 0);
  }
  if (fields.equippedAvatarId !== undefined) { sets.push('equipped_avatar_id = ?'); args.push(fields.equippedAvatarId); }
  // Gated to admin callers and ref-validated by update.ts before this is
  // ever reached — this function trusts its caller, same as every other
  // field here.
  if (fields.overrideSprite !== undefined) { sets.push('override_sprite = ?'); args.push(fields.overrideSprite); }
  if (handle !== undefined) {
    sets.push('handle = ?'); args.push(handle);
    // Every write of the handle column — deliberate or the collision-retry
    // below — stamps the cooldown clock. update.ts is the one place that
    // decides WHETHER a handle write is allowed to happen at all (via
    // canChangeHandle); once it decides to call this, the write always
    // counts.
    sets.push('handle_changed_at = ?'); args.push(t);
  }
  return { sets, args };
}

async function runProfileUpdate(
  db: D1Database, fanId: number, built: { sets: string[]; args: unknown[] }, t: number,
): Promise<void> {
  if (!built.sets.length) return;
  const args = [...built.args, t, fanId];
  await db.prepare(`UPDATE fan_profiles SET ${built.sets.join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...args).run();
}

export async function updateProfile(
  db: D1Database,
  fanId: number,
  fields: {
    displayName?: string; equippedAvatarId?: string | null; handle?: string;
    overrideSprite?: string | null; bio?: string | null; hiddenFromWall?: boolean;
  },
): Promise<void> {
  const t = now();
  if (fields.handle === undefined) {
    await runProfileUpdate(db, fanId, buildProfileSets(fields, undefined, t), t);
    return;
  }

  try {
    await runProfileUpdate(db, fanId, buildProfileSets(fields, fields.handle, t), t);
    return;
  } catch (err) {
    // A concurrent change landed on the same candidate handle first —
    // idx_fan_profiles_handle throws rather than failing silently, same
    // shape as ensureProfile's insert race. Re-derive a fresh candidate off
    // the same base name and retry exactly once.
    const retryBase = fields.displayName ?? fields.handle;
    const retryHandle = await nextAvailableHandle(
      retryBase, async h => !!(await getProfileByHandle(db, h)),
    );
    try {
      await runProfileUpdate(db, fanId, buildProfileSets(fields, retryHandle, t), t);
      return;
    } catch {
      // Still colliding. A fan renaming themselves must never get a 500 over
      // a handle collision — keep the existing handle and persist everything
      // else instead.
      await runProfileUpdate(db, fanId, buildProfileSets(fields, undefined, t), t);
    }
  }
}

/**
 * Delete a fan's profile and everything hanging off it. Ordered
 * children-then-parent and wrapped in a batch so a half-deleted fan (unlocks
 * gone, profile still standing, or vice versa) is not a reachable state —
 * fan_avatar_unlocks has a FK to fan_profiles, but D1 does not guarantee
 * PRAGMA foreign_keys is on for every connection, so the child delete is
 * explicit rather than left to ON DELETE CASCADE.
 *
 * The KV customer record (purchases, download entitlements) is deliberately
 * NOT touched: it belongs to the ACCOUNT, not to the community profile, and
 * a fan who deletes their profile keeps everything they paid for. Signing up
 * again rebuilds a fresh profile from that same record — see ensureProfile.
 */
// ── XP ledger (migration 0013) ──────────────────────────────────────────
//
// The durable half of the hybrid XP model. See the migration header for why
// purchases and tenure stay derived while discrete grants live here.

export interface XpEventInput {
  fanId: number;
  actionType: string;
  xpAmount: number;
  /** Idempotency key. The same key twice is a no-op, never a double award. */
  eventKey: string;
  sourceRef?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Append one XP event. Returns true if it was newly recorded, false if the
 * event_key had already been used — which is a SUCCESS, not an error: it
 * means a retried webhook or a double-clicked button correctly did nothing.
 *
 * The pre-check races with a concurrent insert of the same key, and that is
 * fine: the unique index is what actually guarantees single-award, and
 * INSERT OR IGNORE makes the loser of the race a no-op instead of a 500.
 * The pre-check only decides which boolean we report.
 */
export async function recordXpEvent(db: D1Database, input: XpEventInput): Promise<boolean> {
  const existing = await db.prepare('SELECT 1 AS x FROM xp_events WHERE event_key = ?')
    .bind(input.eventKey).first<{ x: number }>();
  if (existing) return false;

  await db.prepare(
    `INSERT OR IGNORE INTO xp_events
       (fan_id, action_type, xp_amount, event_key, source_ref, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.fanId,
    input.actionType,
    Math.trunc(input.xpAmount),
    input.eventKey,
    input.sourceRef ?? null,
    input.metadata ? JSON.stringify(input.metadata) : null,
    now(),
  ).run();
  return true;
}

/** Live (non-voided) ledger total for one fan. 0 when they have no events. */
export async function sumLedgerXp(db: D1Database, fanId: number): Promise<number> {
  const row = await db.prepare(
    'SELECT COALESCE(SUM(xp_amount), 0) AS total FROM xp_events WHERE fan_id = ? AND voided_at IS NULL',
  ).bind(fanId).first<{ total: number }>();
  return row?.total || 0;
}

/**
 * Reverse a grant without destroying the record of it. The row stops
 * counting toward the fan's total but stays readable, which is the whole
 * reason this is a ledger rather than a counter — "why did my XP drop"
 * has to have an answer.
 */
export async function voidXpEvent(db: D1Database, eventId: number, reason: string): Promise<void> {
  await db.prepare(
    'UPDATE xp_events SET voided_at = ?, voided_reason = ? WHERE id = ? AND voided_at IS NULL',
  ).bind(now(), reason, eventId).run();
}

/** One fan's ledger, newest first — the admin user-inspector view. */
export async function getXpEvents(db: D1Database, fanId: number, limit = 100): Promise<any[]> {
  const { results } = await db.prepare(
    'SELECT * FROM xp_events WHERE fan_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
  ).bind(fanId, Math.min(Math.max(limit | 0, 1), 500)).all();
  return results || [];
}

/**
 * Soft delete: hide the profile everywhere, keep the row restorable until
 * the grace window lapses. This is what POST /api/community/delete calls —
 * the fan-facing "delete my profile" never destroys anything on the spot.
 *
 * The unlock ledger is deliberately left ALONE. Unlocks are re-derived from
 * ownership on every profile read anyway (see evaluateUnlocks in me.ts), so
 * deleting them would buy nothing and would make a restore hand back a
 * profile with an empty shelf until the next read repopulated it.
 */
export async function softDeleteFanProfile(db: D1Database, fanId: number, at: number = now()): Promise<void> {
  await db.prepare('UPDATE fan_profiles SET deleted_at = ?, updated_at = ? WHERE id = ?')
    .bind(at, now(), fanId).run();
}

/** Undo a soft delete. Everything on the row — bio, engagement EP, handle, creature — comes back untouched. */
export async function restoreFanProfile(db: D1Database, fanId: number): Promise<void> {
  await db.prepare('UPDATE fan_profiles SET deleted_at = NULL, updated_at = ? WHERE id = ?')
    .bind(now(), fanId).run();
}

/**
 * The real, irreversible delete. Reached two ways, never directly by a
 * "delete my profile" click: the grace window ran out, or the fan explicitly
 * discarded a profile that was already soft-deleted.
 */
export async function purgeFanProfile(db: D1Database, fanId: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM fan_avatar_unlocks WHERE fan_id = ?').bind(fanId),
    // xp_events and discord_links both CASCADE, but only where foreign keys
    // are enforced — deleting explicitly means neither can outlive its fan on
    // a connection where that pragma is off. An orphaned discord_links row is
    // the worse of the two: discord_user_id is UNIQUE, so a stale row would
    // permanently block that person from ever linking a new profile.
    db.prepare('DELETE FROM xp_events WHERE fan_id = ?').bind(fanId),
    db.prepare('DELETE FROM discord_links WHERE fan_id = ?').bind(fanId),
    db.prepare('DELETE FROM fan_profiles WHERE id = ?').bind(fanId),
  ]);
}

/**
 * Sweep every profile whose grace window has lapsed. Pages Functions have no
 * cron, so this is not self-firing: /api/community/me purges opportunistically
 * when the owner returns (the case that actually matters, since it frees their
 * email and handle), and this bulk version backs it up for fans who never come
 * back — run it from `npm run d1:purge-deleted`. Returns how many were purged.
 */
export async function purgeExpiredProfiles(db: D1Database, now: number): Promise<number> {
  const cutoff = now - DELETE_GRACE_SECONDS;
  const { results } = await db.prepare(
    'SELECT id FROM fan_profiles WHERE deleted_at IS NOT NULL AND deleted_at < ?',
  ).bind(cutoff).all<{ id: number }>();
  const ids = (results || []).map(r => r.id);
  for (const id of ids) await purgeFanProfile(db, id);
  return ids.length;
}

export async function setCollectionCount(db: D1Database, fanId: number, count: number): Promise<void> {
  await db.prepare('UPDATE fan_profiles SET collection_count = ?, updated_at = ? WHERE id = ?')
    .bind(count, now(), fanId).run();
}

/**
 * Persist a fan's creature stage progress — see evaluateCreature in
 * creature.ts, which computes what to write. Called on every profile read
 * (idempotent: writing the same stage twice is harmless), which is what
 * makes visiting your own profile the trigger for advancing. `hatchedAt` is
 * passed through unchanged by every caller once set — see me.ts.
 */
export async function saveCreatureProgress(
  db: D1Database,
  fanId: number,
  update: { ep: number; stage: string; hatchedAt: number | null },
): Promise<void> {
  await db.prepare(
    'UPDATE fan_profiles SET ep = ?, stage = ?, hatched_at = ?, updated_at = ? WHERE id = ?',
  ).bind(update.ep, update.stage, update.hatchedAt, now(), fanId).run();
}

/**
 * Read the engagement bookkeeping columns (migration 0010) as the pure
 * EngagementState shape engagement.ts's applyEngagementReport works with —
 * keeps the JSON parse (and its defensive fallback) in one place rather than
 * repeating it at every caller. A malformed engagement_listened_today value
 * (should never happen — it is only ever written by saveEngagementState
 * below) is treated as an empty day rather than throwing, since losing a
 * day's listen-dedup bookkeeping is harmless and far better than a 500.
 */
export async function getEngagementState(db: D1Database, fanId: number): Promise<EngagementState> {
  const row = await db.prepare(
    `SELECT engagement_day, engagement_clicks_today, engagement_active_seconds_today,
            engagement_listen_xp_today, engagement_listened_today, engagement_last_seq, engagement_ep
       FROM fan_profiles WHERE id = ?`,
  ).bind(fanId).first<{
    engagement_day: string | null;
    engagement_clicks_today: number;
    engagement_active_seconds_today: number;
    engagement_listen_xp_today: number;
    engagement_listened_today: string;
    engagement_last_seq: number;
    engagement_ep: number;
  }>();
  let listened: Record<string, ListenFlags> = {};
  try {
    if (row?.engagement_listened_today) {
      const parsed = JSON.parse(row.engagement_listened_today);
      if (parsed && typeof parsed === 'object') listened = parsed;
    }
  } catch { /* treat as empty — see doc comment above */ }
  return {
    day: row?.engagement_day ?? null,
    clicksToday: row?.engagement_clicks_today || 0,
    activeSecondsToday: row?.engagement_active_seconds_today || 0,
    listenXpToday: row?.engagement_listen_xp_today || 0,
    listened,
    lastSeq: row?.engagement_last_seq || 0,
    lifetimeEp: row?.engagement_ep || 0,
  };
}

/** Persist a new EngagementState — the only place engagement_* columns are ever written. */
export async function saveEngagementState(db: D1Database, fanId: number, state: EngagementState): Promise<void> {
  await db.prepare(
    `UPDATE fan_profiles
       SET engagement_day = ?, engagement_clicks_today = ?, engagement_active_seconds_today = ?,
           engagement_listen_xp_today = ?, engagement_listened_today = ?, engagement_last_seq = ?,
           engagement_ep = ?, updated_at = ?
       WHERE id = ?`,
  ).bind(
    state.day, state.clicksToday, state.activeSecondsToday, state.listenXpToday,
    JSON.stringify(state.listened), state.lastSeq, state.lifetimeEp, now(), fanId,
  ).run();
}

/**
 * A fan's own choice — sprite refs are fate (fixed at creation, see
 * ensureProfile), colourway is the one thing they pick. update.ts is
 * responsible for validating `colourway` is one of the 12 real ids
 * (sprites.ts's isValidColourway) before this is ever called.
 */
export async function setCreatureColourway(db: D1Database, fanId: number, colourway: string): Promise<void> {
  await db.prepare('UPDATE fan_profiles SET colourway = ?, updated_at = ? WHERE id = ?')
    .bind(colourway, now(), fanId).run();
}

/**
 * Backfill sprite refs + colourway for a fan whose profile predates
 * migration 0007 (sprite_egg etc. are NULL). No-op for anyone assigned
 * already — this must never re-roll an existing assignment. Deliberately
 * NOT called from directory.ts or profile.ts (see their subrequest budget
 * comments); only me.ts's self-view calls this, since that keeps the write
 * cost to "once, ever, per legacy fan, on their own visit" rather than a
 * write fanning out across every row a directory/profile read touches.
 */
export async function ensureSpriteAssignment(db: D1Database, profile: FanProfileRow): Promise<FanProfileRow> {
  if (profile.sprite_egg) return profile;
  const sprites = await assignSpriteRefs(profile.email);
  await db.prepare(
    `UPDATE fan_profiles
       SET sprite_egg = ?, sprite_grub = ?, sprite_pupa = ?, sprite_adult = ?, colourway = ?, updated_at = ?
       WHERE id = ? AND sprite_egg IS NULL`,
  ).bind(
    sprites.sprite_egg, sprites.sprite_grub, sprites.sprite_pupa, sprites.sprite_adult, sprites.colourway,
    now(), profile.id,
  ).run();
  return { ...profile, ...sprites };
}

/**
 * The ONLY shape that may be sent to a client. Constructed by explicit
 * allow-list rather than by deleting fields, so a column added to
 * fan_profiles OR avatar_catalogue later cannot leak by default.
 */
/**
 * The sprite ref to render for this fan. An admin override (migration 0008)
 * wins unconditionally, regardless of the fan's real stage — that's the
 * whole point (see currentSpriteRef's caller, toPublicProfile, and the
 * override_sprite column doc comment on FanProfileRow). Otherwise falls
 * through to the normal stage-derived per-stage column.
 */
function currentSpriteRef(row: FanProfileRow, stage: CreatureStage): string | null {
  if (row.override_sprite) return row.override_sprite;
  switch (stage) {
    case 'egg': return row.sprite_egg;
    case 'grub': return row.sprite_grub;
    case 'pupa': return row.sprite_pupa;
    case 'adult': return row.sprite_adult;
  }
}

export function toPublicProfile(
  row: FanProfileRow,
  avatar: AvatarCatalogueRow | null,
): PublicProfile {
  // row.stage is undefined (not just null) for any plain object built before
  // migration 0006 existed — e.g. hand-built rows in older tests — so `||`
  // rather than `??` deliberately treats both as "egg".
  const stage = (row.stage || 'egg') as CreatureStage;
  return {
    handle: row.handle,
    display_name: row.display_name,
    fan_since: row.fan_since,
    rank_points: row.rank_points,
    collection_count: row.collection_count,
    bio: row.bio || null,
    avatar: avatar ? {
      id: avatar.id,
      name: avatar.name,
      art_path: avatar.art_path,
      // Tier-ladder recipe fields — see PublicAvatar's doc comment.
      // Necessary for tiers 1/2/4 to render for anyone but the signed-in
      // viewer looking at their own avatar; null on plain release/special
      // rows, which fall back to art_path exactly as before.
      style: avatar.style,
      colourway: avatar.colourway,
      artwork_key: avatar.artwork_key,
      tier: avatar.tier,
    } : null,
    creature: {
      stage,
      sprite_ref: currentSpriteRef(row, stage),
      colourway: row.colourway || null,
      ep: row.ep || 0,
      stage_xp: stageXp(row.ep || 0, stage),
      next_stage_ep: nextStageThreshold(stage),
    },
  };
}

/* ---------------------------------------------------------------------
 * Discord links (migration 0013)
 *
 * The link handshake is one-directional by necessity: the bot can reach
 * Cloudflare, Cloudflare cannot reach the bot's home container. So the bot
 * registers a code here, and the fan redeems it from their own session.
 * ------------------------------------------------------------------- */

export interface DiscordLinkRow {
  fan_id: number;
  discord_user_id: string;
  linked_at: number;
  discord_ep: number;
}

export async function getDiscordLinkByFan(db: D1Database, fanId: number) {
  return db.prepare('SELECT * FROM discord_links WHERE fan_id = ?')
    .bind(fanId).first<DiscordLinkRow>();
}

export async function getDiscordLinkByUser(db: D1Database, discordUserId: string) {
  return db.prepare('SELECT * FROM discord_links WHERE discord_user_id = ?')
    .bind(discordUserId).first<DiscordLinkRow>();
}

export async function saveDiscordLinkCode(
  db: D1Database, code: string, discordUserId: string, createdAt: number, expiresAt: number,
): Promise<void> {
  // One pending code per Discord account: re-running /link replaces the
  // previous code rather than leaving several live at once, so a code read
  // over someone's shoulder stops working the moment the owner re-runs it.
  await db.prepare('DELETE FROM discord_link_codes WHERE discord_user_id = ?')
    .bind(discordUserId).run();
  await db.prepare(
    'INSERT INTO discord_link_codes (code, discord_user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).bind(code, discordUserId, createdAt, expiresAt).run();
}

/**
 * Look up a code and delete it in the same call — a code is single-use, and
 * leaving deletion to the caller would make "used" depend on the caller
 * remembering. Returns null for unknown OR expired codes; the caller cannot
 * tell which, on purpose, since distinguishing them tells an attacker
 * whether a guessed code ever existed.
 */
export async function consumeDiscordLinkCode(
  db: D1Database, code: string, nowSec: number,
): Promise<string | null> {
  const row = await db.prepare('SELECT discord_user_id, expires_at FROM discord_link_codes WHERE code = ?')
    .bind(code).first<{ discord_user_id: string; expires_at: number }>();
  if (!row) return null;
  await db.prepare('DELETE FROM discord_link_codes WHERE code = ?').bind(code).run();
  if (row.expires_at < nowSec) return null;
  return row.discord_user_id;
}

/** Housekeeping — expired codes are dead weight, swept opportunistically. */
export async function purgeExpiredDiscordLinkCodes(db: D1Database, nowSec: number): Promise<void> {
  await db.prepare('DELETE FROM discord_link_codes WHERE expires_at < ?').bind(nowSec).run();
}

export async function createDiscordLink(
  db: D1Database, fanId: number, discordUserId: string, nowSec: number,
): Promise<void> {
  await db.prepare(
    'INSERT INTO discord_links (fan_id, discord_user_id, linked_at, discord_ep) VALUES (?, ?, ?, 0)',
  ).bind(fanId, discordUserId, nowSec).run();
}

export async function deleteDiscordLink(db: D1Database, fanId: number): Promise<void> {
  await db.prepare('DELETE FROM discord_links WHERE fan_id = ?').bind(fanId).run();
}

/**
 * Add `amount` to a linked fan's Discord EP and return the new total, or
 * null if that Discord account is not linked to anyone.
 *
 * The UPDATE reads and writes in a single statement (`discord_ep = discord_ep + ?`)
 * rather than reading, adding in JS and writing back: two awards landing at
 * once — a message and a reaction in the same second — would otherwise both
 * read the same old value and one increment would vanish. D1 has no
 * interactive transactions, so an atomic statement is the mechanism
 * available here, and it is sufficient because addition commutes.
 */
export async function addDiscordEp(
  db: D1Database, discordUserId: string, amount: number,
): Promise<number | null> {
  await db.prepare(
    'UPDATE discord_links SET discord_ep = MAX(0, discord_ep + ?) WHERE discord_user_id = ?',
  ).bind(amount, discordUserId).run();
  // "Was there a row?" is answered by the read-back, not by the UPDATE's
  // meta.changes: an unlinked account updates nothing and reads back
  // nothing, which is the same null either way, and this does not depend on
  // driver-specific result metadata.
  const row = await db.prepare('SELECT discord_ep FROM discord_links WHERE discord_user_id = ?')
    .bind(discordUserId).first<{ discord_ep: number }>();
  return row?.discord_ep ?? null;
}

/**
 * Claim an award's event_key, returning true if THIS call claimed it.
 *
 * False means the award was already applied by an earlier delivery — the
 * caller must then report current state rather than incrementing again.
 * addDiscordEp is a relative increment, so a second application would
 * inflate the fan's EP permanently (resolveStage never demotes).
 *
 * INSERT OR IGNORE ... RETURNING is the whole mechanism, and it is one
 * statement on purpose. A SELECT-then-INSERT would let two concurrent
 * retries both read "not applied" and both proceed. Comparing a written
 * timestamp is no better: two retries landing in the same second would both
 * match and both believe they claimed it. RETURNING yields a row only to the
 * caller whose insert actually took, which is exactly the question being
 * asked, decided by the PRIMARY KEY itself.
 */
export async function claimAwardEvent(
  db: D1Database, eventKey: string, nowSec: number,
): Promise<boolean> {
  const row = await db.prepare(
    'INSERT OR IGNORE INTO discord_award_events (event_key, applied_at) VALUES (?, ?) '
    + 'RETURNING event_key',
  ).bind(eventKey, nowSec).first<{ event_key: string }>();
  return !!row;
}
