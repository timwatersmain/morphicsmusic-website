/**
 * rebuild-fan-projection.mjs
 *
 * Regenerates every DERIVED field in the D1 fan projection from KV, which is
 * the source of truth. Fan-owned fields — handle, display_name,
 * equipped_avatar_id — are never written here, so a rebuild cannot clobber
 * somebody's identity.
 *
 * This is what makes the KV/D1 split safe: drift is a recoverable
 * inconvenience rather than data loss.
 *
 *   node scripts/rebuild-fan-projection.mjs --dry-run
 *   node scripts/rebuild-fan-projection.mjs --local
 *   node scripts/rebuild-fan-projection.mjs --remote
 *
 * Requires `wrangler login` for --remote. --local (the default) talks only
 * to wrangler's local emulated D1/KV storage and needs no credentials at
 * all, which is what makes `--dry-run` usable fully offline.
 *
 * The KV binding (DOWNLOADS) is configured for the live site in the
 * Cloudflare Pages dashboard, same as tools/d1/wrangler.toml for D1 — see
 * that file for why no config lives at the repo root. tools/kv/wrangler.toml
 * mirrors it for this script: only ever used via --config, and its `id` is
 * a placeholder that --local ignores entirely. Filling in the real
 * namespace id (from `wrangler kv namespace list`) is required before this
 * script can ever run with --remote.
 *
 * SAFETY: this file must never contain the strings "handle =",
 * "display_name =", or "equipped_avatar_id =" as part of building SQL —
 * see FORBIDDEN_COLUMNS and assertNoFanOwnedWrites() below, which scan
 * every generated statement and throw before anything is written or
 * executed. That is the second line of defense; the first is structural —
 * buildRebuildSql() below has exactly one UPDATE column list and one INSERT
 * column list, both hardcoded to derived-only / ledger-only columns, so
 * there is nowhere for a fan-owned column to sneak in.
 */

import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

// Reuses the real unlock engine rather than re-deriving its rules here —
// duplicating `qualifies()` in this script would drift from
// functions/_lib/community/unlocks.ts the first time a rule type changes.
import { evaluateUnlocks } from '../functions/_lib/community/unlocks.ts';

const KV_CONFIG = 'tools/kv/wrangler.toml';
const D1_CONFIG = 'tools/d1/wrangler.toml';

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

/** SQL string literal — doubles single quotes, same convention as sync-avatar-catalogue.mjs. */
function q(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Parse one `customer:<email>` KV value into the shape the unlock engine
 * needs. Returns fanSince: null when the record has nothing usable — the
 * caller skips those rather than writing a fan_since of 0.
 */
export function parseCustomerRecord(email, raw) {
  let record = {};
  try {
    if (raw) record = JSON.parse(raw);
  } catch {
    record = {}; // malformed KV value — treat as empty, never throw mid-rebuild
  }
  const owned = new Set();
  for (const p of record.purchases || []) {
    for (const s of p.music_release_slugs || []) owned.add(s);
    for (const d of p.digital_slugs || []) owned.add(d);
  }
  return {
    email: email.toLowerCase().trim(),
    fanSince: record.first_seen_at || null,
    ownedSlugs: [...owned],
  };
}

// The only two columns a rebuild is ever allowed to UPDATE, and the only
// columns an unlock INSERT ever touches. Never add handle, display_name or
// equipped_avatar_id here.
const FAN_PROFILE_DERIVED_COLUMNS = ['fan_since', 'collection_count', 'updated_at'];
const FORBIDDEN_COLUMNS = ['handle', 'display_name', 'equipped_avatar_id'];

/**
 * Belt-and-suspenders check: scans the fully-built SQL text for an
 * assignment or an INSERT column list touching a fan-owned column, and
 * throws before the caller can print or execute it. This exists precisely
 * because "we didn't write code that does X" is not the same guarantee as
 * "the code cannot do X" — a future edit to buildRebuildSql() that adds a
 * column trips this immediately, in CI, instead of silently shipping.
 */
export function assertNoFanOwnedWrites(sql) {
  for (const col of FORBIDDEN_COLUMNS) {
    const assignment = new RegExp(`\\b${col}\\s*=`, 'i');
    const insertColumnList = new RegExp(`\\([^)]*\\b${col}\\b[^)]*\\)\\s*\\n?\\s*(SELECT|VALUES)`, 'i');
    if (assignment.test(sql) || insertColumnList.test(sql)) {
      throw new Error(
        `rebuild-fan-projection: generated SQL touches fan-owned column "${col}" — refusing to emit`,
      );
    }
  }
  return sql;
}

/**
 * Build the full rebuild SQL for a batch of fans. Pure — no wrangler, no
 * filesystem — so it can be exercised offline with fixture data.
 *
 *   fans: [{ email, fanSince, ownedSlugs }]
 *   catalogue: avatar_catalogue rows (AvatarCatalogueRow shape)
 *   now: unix seconds, fixed once by the caller so every statement in the
 *        batch agrees on "now"
 *
 * Fans are matched to fan_profiles by email via a subselect rather than a
 * pre-fetched fan_id, so this stays a single SQL file with no per-fan round
 * trip. A fan with no existing fan_profiles row (never signed in) simply
 * matches zero rows — harmless, and correct: rebuild fixes drift for
 * profiles that exist, it does not manufacture new fan identities, because
 * identity (handle, display_name) is fan-owned and this script cannot
 * originate one.
 */
export function buildRebuildSql(fans, catalogue, now) {
  const statements = [];
  for (const fan of fans) {
    if (!fan.fanSince) continue; // no usable KV data — nothing to derive
    const email = q(fan.email);

    statements.push(
      `UPDATE fan_profiles SET fan_since = ${fan.fanSince}, collection_count = ${fan.ownedSlugs.length}, updated_at = ${now} WHERE email = ${email};`,
    );

    const grants = evaluateUnlocks(
      {
        ownedSlugs: fan.ownedSlugs,
        fanSince: fan.fanSince,
        now,
        // Same placeholders as functions/api/community/me.ts — these
        // systems don't exist yet, so nothing derivable comes from them.
        streakWeeks: 0,
        showsAttended: [],
        gatesCompleted: [],
      },
      catalogue,
    );

    for (const g of grants) {
      statements.push(
        `INSERT INTO fan_avatar_unlocks (fan_id, avatar_id, unlocked_at, source, source_ref)\n` +
        `  SELECT id, ${q(g.avatarId)}, ${now}, ${q(g.source)}, ${q(g.sourceRef)} FROM fan_profiles WHERE email = ${email}\n` +
        `  ON CONFLICT (fan_id, avatar_id) DO NOTHING;`,
      );
    }
  }
  const sql = statements.join('\n');
  return assertNoFanOwnedWrites(sql);
}

function wrangler(cmdArgs) {
  return execFileSync('npx', ['--yes', 'wrangler', ...cmdArgs], { encoding: 'utf8' });
}

function listCustomerKeys(target) {
  const out = wrangler([
    'kv', 'key', 'list', '--binding', 'DOWNLOADS', '--config', KV_CONFIG, target, '--prefix', 'customer:',
  ]);
  return JSON.parse(out).map(k => k.name);
}

function getCustomerRecord(key, target) {
  return wrangler(['kv', 'key', 'get', key, '--binding', 'DOWNLOADS', '--config', KV_CONFIG, target]);
}

function fetchCatalogue(target) {
  const out = wrangler([
    'd1', 'execute', 'GATES', '--config', D1_CONFIG, target, '--json', '--command', 'SELECT * FROM avatar_catalogue',
  ]);
  const parsed = JSON.parse(out);
  return parsed[0]?.results || [];
}

// Only run the CLI half when invoked directly, so importing for tests is free.
if (process.argv[1] && process.argv[1].endsWith('rebuild-fan-projection.mjs')) {
  const target = args.remote ? '--remote' : '--local';
  const now = Math.floor(Date.now() / 1000);

  console.log(`Fetching avatar catalogue (${target})...`);
  const catalogue = fetchCatalogue(target);
  console.log(`  ${catalogue.length} avatar(s) in the catalogue.`);

  console.log(`Listing customer records (${target})...`);
  const keys = listCustomerKeys(target);
  console.log(`  ${keys.length} customer key(s).`);

  const fans = [];
  let skipped = 0;
  for (const key of keys) {
    const email = key.replace(/^customer:/, '');
    const raw = getCustomerRecord(key, target);
    const parsed = parseCustomerRecord(email, raw);
    if (parsed.fanSince) fans.push(parsed);
    else skipped++;
  }
  if (skipped) console.log(`  ${skipped} record(s) skipped — no first_seen_at.`);

  const sql = buildRebuildSql(fans, catalogue, now);

  if (!sql.trim()) {
    console.log('Nothing to rebuild.');
    process.exit(0);
  }

  if (args['dry-run']) {
    console.log(`\n-- ${fans.length} fan(s), ${sql.split('\n').filter(l => l.startsWith('UPDATE') || l.startsWith('INSERT')).length} statement(s) --\n`);
    console.log(sql);
    console.log(`\nDry run (${target}) — nothing executed.`);
    process.exit(0);
  }

  const tmp = join(process.cwd(), '.rebuild-fan-projection.sql');
  writeFileSync(tmp, sql);
  try {
    execFileSync('npx', ['--yes', 'wrangler', 'd1', 'execute', 'GATES', '--config', D1_CONFIG, target, `--file=${tmp}`], { stdio: 'inherit' });
    console.log(`Rebuilt ${fans.length} fan(s) (${target}).`);
  } finally {
    unlinkSync(tmp);
  }
}
