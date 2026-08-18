-- Hard-delete every fan profile whose 30-day delete grace window has lapsed.
--
-- Pages Functions have no cron, so this sweep is not self-firing. It is the
-- BACKSTOP, not the primary path: /api/community/me purges a lapsed profile
-- the moment its owner returns (which is when it matters, because that is
-- what frees their email and handle for a fresh profile). This exists for
-- the fans who never come back, so their rows do not linger indefinitely.
--
-- Safe to run any time, including twice: it only ever touches rows that are
-- BOTH soft-deleted and past their deadline, and a second run finds none.
-- It can never touch a live profile — deleted_at IS NULL is not < anything.
--
--   npm run d1:purge-deleted:local     (local D1)
--   npm run d1:purge-deleted           (production — real, irreversible)
--
-- The 2592000 below is 30 days in seconds, and it MUST stay in step with
-- DELETE_GRACE_DAYS in functions/_lib/community/repo.ts, which is the value
-- every user-facing date and every code path is computed from. If you change
-- the window, change it there first and mirror it here.

DELETE FROM fan_avatar_unlocks
  WHERE fan_id IN (
    SELECT id FROM fan_profiles
      WHERE deleted_at IS NOT NULL
        AND deleted_at < (CAST(strftime('%s', 'now') AS INTEGER) - 2592000)
  );

DELETE FROM fan_profiles
  WHERE deleted_at IS NOT NULL
    AND deleted_at < (CAST(strftime('%s', 'now') AS INTEGER) - 2592000);
