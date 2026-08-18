-- 0014_xp_events.sql
-- The XP ledger: append-only, idempotent, auditable.
--
-- Until now `fan_profiles.ep` was a CACHE OF A FORMULA, not a balance.
-- computeEp() recalculated it from purchases + tenure + engagement on every
-- profile read and wrote the result over the column, which meant any XP that
-- was not one of those three inputs was silently erased on the fan's next
-- page load. POST /api/admin/grant-ep did exactly that: grant 1000 EP, fan
-- opens their profile, EP is back to 6 while the stage stays advanced.
--
-- This table is where discrete grants live so they survive that recompute.
-- After this migration the model is a deliberate HYBRID:
--
--     ep = purchases + tenure + engagement   (still derived, still live)
--        + SUM(xp_events)                    (durable, auditable, voidable)
--
-- Keeping purchases derived is not laziness — it is what makes refund and
-- chargeback reversal automatic (the Stripe webhook prunes the purchase and
-- the next recompute reverses the XP with no compensating entry). Tenure is
-- derived because it accrues continuously at 0.2/day and Pages Functions
-- have no cron to write daily events with.
--
-- Columns:
--   fan_id        -- fan_profiles.id. CASCADE so a purged profile takes its
--                    ledger with it. A SOFT-deleted profile keeps its events,
--                    which is what makes profile restore return real XP.
--   action_type   -- 'admin_grant', 'ticket_purchase', 'referral', ... Free
--                    text on purpose: new earn types must not need a
--                    migration, and an unknown type is still summable.
--   xp_amount     -- signed. A correction is a negative row, never an UPDATE
--                    and never a DELETE, so the history stays readable.
--   event_key     -- UNIQUE. The idempotency guarantee: a retried webhook, a
--                    double-clicked button or a replayed job re-inserts the
--                    same key and is a no-op instead of double-awarding.
--   season_id     -- nullable, unused today. Seasons are not built yet; the
--                    column exists now so adding them later is a write, not a
--                    table rebuild.
--   voided_at /
--   voided_reason -- an admin reversal marks the row voided (excluded from
--                    the sum) rather than deleting it. Deleting the evidence
--                    of a reversal is how disputes become unanswerable.
--
-- Rollback: see migrations/down/0013_xp_events.down.sql

CREATE TABLE xp_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  fan_id        INTEGER NOT NULL REFERENCES fan_profiles (id) ON DELETE CASCADE,
  action_type   TEXT    NOT NULL,
  xp_amount     INTEGER NOT NULL,
  event_key     TEXT    NOT NULL,
  season_id     INTEGER,
  source_ref    TEXT,
  metadata      TEXT,
  voided_at     INTEGER,
  voided_reason TEXT,
  created_at    INTEGER NOT NULL
);

-- The idempotency constraint itself. Everything else in this file is
-- bookkeeping; this index is the rule.
CREATE UNIQUE INDEX idx_xp_events_key ON xp_events (event_key);

-- The one hot read: every profile load sums a single fan's live events.
CREATE INDEX idx_xp_events_fan ON xp_events (fan_id, voided_at);
