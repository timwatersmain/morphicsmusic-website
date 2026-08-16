-- 0001_download_gates.sql
-- Download gate system: campaign pages that trade a free file for verified
-- email + social actions.
--
-- Purely additive. Creates five new tables and touches nothing that already
-- exists — the store's data lives in KV and R2, not here, so no existing
-- column can be dropped or altered by this migration.
--
-- Rollback: migrations/down/0001_download_gates.down.sql
--
-- Times are unix epoch seconds (INTEGER), matching the convention already used
-- throughout the KV records (see functions/api/stripe-webhook.ts). Booleans are
-- INTEGER 0/1. JSON blobs are TEXT.

-- ── gates ───────────────────────────────────────────────────────────────
CREATE TABLE gates (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  slug                TEXT    NOT NULL,
  title               TEXT    NOT NULL,
  subtitle            TEXT,
  artwork_path        TEXT,
  preview_audio_path  TEXT,

  -- R2 object key under the `gates/` prefix, e.g. gates/acid-pack/pack.zip.
  -- This is the allow-list: the delivery endpoint will only ever serve a key
  -- that an active gate row declares, mirroring how digital.json gates
  -- functions/api/download.ts today.
  file_storage_key    TEXT    NOT NULL,
  file_label          TEXT,
  file_size_bytes     INTEGER,

  active              INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  published_at        INTEGER,
  expires_at          INTEGER,

  -- JSON object of per-gate visual overrides (accent colour etc). NULL means
  -- inherit the site theme from tailwind.config.mjs.
  theme_overrides     TEXT,

  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Required by the brief, and the lookup every page load does.
CREATE UNIQUE INDEX idx_gates_slug ON gates (slug);
CREATE INDEX idx_gates_active ON gates (active, published_at);

-- ── gate_actions ────────────────────────────────────────────────────────
CREATE TABLE gate_actions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  gate_id             INTEGER NOT NULL REFERENCES gates (id) ON DELETE CASCADE,
  ordinal             INTEGER NOT NULL,

  type                TEXT    NOT NULL,
  target_url          TEXT,

  -- SoundCloud URN ("soundcloud:tracks:12345678") or numeric id. SoundCloud
  -- is migrating id -> urn, so this is TEXT and never INTEGER.
  target_resource_id  TEXT,

  verification_mode   TEXT    NOT NULL,
  label               TEXT,
  required            INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  created_at          INTEGER NOT NULL,

  -- HARD CONSTRAINT #1, enforced in the schema rather than trusted to
  -- application code: only the action types that can genuinely be checked
  -- server-side are permitted to store verification_mode = 'verified'.
  -- Spotify, Instagram, TikTok, YouTube, Bandcamp, Facebook and X have no
  -- public API that answers "did this visitor follow me", so a row claiming
  -- to verify one of them is rejected by the database itself. There is no
  -- code path — present or future, including a bad admin payload — that can
  -- write an attested action labelled as verified.
  CHECK (verification_mode IN ('verified', 'attested')),
  CHECK (
    verification_mode = 'attested'
    OR type IN (
      'soundcloud_follow',
      'soundcloud_like',
      'soundcloud_repost',
      'soundcloud_comment',
      'email'
    )
  ),

  CHECK (type IN (
    'soundcloud_follow',
    'soundcloud_like',
    'soundcloud_repost',
    'soundcloud_comment',
    'email',
    'spotify_follow',
    'spotify_save',
    'instagram_follow',
    'tiktok_follow',
    'youtube_subscribe',
    'bandcamp_follow',
    'facebook_follow',
    'x_follow',
    'visit_link'
  ))
);

CREATE UNIQUE INDEX idx_gate_actions_order ON gate_actions (gate_id, ordinal);
CREATE INDEX idx_gate_actions_gate ON gate_actions (gate_id);

-- ── gate_unlocks ────────────────────────────────────────────────────────
-- One row per (gate, email). Created when the visitor submits their email,
-- completed once every required action is satisfied. Keeping it unique per
-- person makes the re-download cap meaningful and keeps the funnel stats
-- honest (a refresh is not a second lead).
CREATE TABLE gate_unlocks (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  gate_id               INTEGER NOT NULL REFERENCES gates (id) ON DELETE CASCADE,

  -- Deviation from the brief, deliberate: the brief specifies `user_id`, but
  -- this site has no numeric user id. Identity is the email address, and the
  -- customer record is the KV key `customer:<email>` (see
  -- functions/api/stripe-webhook.ts:141). So the nullable link to the user
  -- record is that key. NULL until a customer record exists for this person.
  -- Storing the key rather than inventing an id keeps a single user identity,
  -- as required — this table is an event log, not a second user table.
  customer_key          TEXT,

  email                 TEXT    NOT NULL,
  -- Double opt-in: NULL until the confirmation link is clicked. The unlock
  -- cannot complete while this is NULL.
  email_confirmed_at    INTEGER,

  -- Hashed, never raw (Phase 7 constraint). HMAC-SHA256 with AUTH_SECRET so
  -- the hashes are not rainbow-table-able back to an IP.
  ip_hash               TEXT,
  user_agent_hash       TEXT,

  utm_source            TEXT,
  utm_medium            TEXT,
  utm_campaign          TEXT,
  utm_content           TEXT,
  utm_term              TEXT,
  referrer              TEXT,

  -- Consent evidence captured at the moment this person ticked the box.
  -- Also mirrored onto the customer record, but kept here as the immutable
  -- per-event record: the customer record shows current consent state, this
  -- shows exactly what wording was on screen when consent was given.
  marketing_consent_at  INTEGER,
  consent_text_snapshot TEXT,

  completed_at          INTEGER,
  download_count        INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_gate_unlocks_gate_email ON gate_unlocks (gate_id, email);
-- Required by the brief. The gate_id index is covered by the unique index
-- above (leftmost prefix), but email is queried on its own for CSV export
-- and for "which gates has this person come through".
CREATE INDEX idx_gate_unlocks_email ON gate_unlocks (email);
CREATE INDEX idx_gate_unlocks_completed ON gate_unlocks (gate_id, completed_at);

-- ── gate_action_completions ─────────────────────────────────────────────
CREATE TABLE gate_action_completions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  unlock_id              INTEGER NOT NULL REFERENCES gate_unlocks (id) ON DELETE CASCADE,
  action_id              INTEGER NOT NULL REFERENCES gate_actions (id) ON DELETE CASCADE,

  -- HARD CONSTRAINT #2: what actually happened, recorded honestly. This is
  -- the value the UI, the CSV export and the admin stats all read. It is
  -- written from the verifier's own result, never from the action's
  -- configured mode, so a 'verified' action that falls back at runtime is
  -- stored as 'attested'.
  verification_mode_used TEXT    NOT NULL CHECK (verification_mode_used IN ('verified', 'attested')),

  verified_at            INTEGER NOT NULL,
  raw_evidence           TEXT,

  UNIQUE (unlock_id, action_id)
);

CREATE INDEX idx_gate_completions_unlock ON gate_action_completions (unlock_id);
CREATE INDEX idx_gate_completions_action ON gate_action_completions (action_id, verification_mode_used);

-- ── gate_events ─────────────────────────────────────────────────────────
-- Not named in the brief's table list, but Phase 5 asks for per-gate views
-- and per-step completion rates, and Phase 7 asks that verification failures
-- be logged for review. Both need an append-only event log; one table serves
-- both rather than two near-identical ones.
CREATE TABLE gate_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  gate_id    INTEGER NOT NULL REFERENCES gates (id) ON DELETE CASCADE,
  unlock_id  INTEGER REFERENCES gate_unlocks (id) ON DELETE SET NULL,
  action_id  INTEGER REFERENCES gate_actions (id) ON DELETE SET NULL,

  type       TEXT    NOT NULL CHECK (type IN (
    'gate_view',
    'action_started',
    'action_completed',
    'action_failed',
    'email_submitted',
    'email_confirmed',
    'unlock_completed',
    'download_delivered'
  )),

  detail     TEXT,
  ip_hash    TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_gate_events_gate_type ON gate_events (gate_id, type, created_at);
CREATE INDEX idx_gate_events_unlock ON gate_events (unlock_id);
