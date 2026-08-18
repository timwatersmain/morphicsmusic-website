// POST /api/free-token — redeem a fan's one-time free-song token.
//
// A verified fan gets exactly one token (granted in functions/api/auth
// /verify-email.ts) that they may spend on any single track of their
// choosing. This endpoint is the only place that spend happens; once spent,
// the chosen file key rides on the customer record forever and
// functions/api/download.ts's cookie-authenticated path treats it as owned.
//
// KV has no compare-and-swap, so a naive read-then-write here can let two
// concurrent requests both observe "unspent" and both write — one spend
// would silently overwrite the other. This handler narrows (does not
// eliminate) that window by re-reading and re-checking immediately before
// the write, and makes the write idempotent on the winning key: a replayed
// request for the SAME key that already won returns success again rather
// than erroring, while a request for a DIFFERENT key once something is
// already spent is always refused. The residual race is: two different
// keys submitted at nearly the same instant, both passing both checks
// before either write lands — the second write still wins and "spends"
// the fan's token on its key, but the fan still only ever gets ONE track
// for free, which is the property that actually matters here. A true fix
// needs a KV binding with CAS/transactions, which this project doesn't have.
import manifest from '../../src/data/masters-manifest.json';
import catalog from '../../src/data/music-catalog.json';
import { isReleased } from '../_lib/release-gate.mjs';
import { readCookie, verifySession, SESSION_COOKIE, LEGACY_SESSION_COOKIE } from '../_lib/auth';
import { corsHandler, preflight } from '../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../_lib/ratelimit';
import { getCustomerRecord, saveCustomerRecord } from '../_lib/customer';

interface Env {
  AUTH_SECRET: string;
  DOWNLOADS: KVNamespace;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Resolve a requested R2 key to the exact manifest entry that publishes it,
// same allow-list discipline as download.ts's parseAndValidateKey — a free
// token can only ever redeem a key that's actually in the masters manifest
// for a released release, never an arbitrary string.
function resolveMasterKey(key: string): { slug: string } | null {
  if (!key || key.length > 256 || key.includes('\0') || key.includes('\\')) return null;
  const releases = (manifest as any).releases || {};
  for (const slug of Object.keys(releases)) {
    const entries = releases[slug] as Array<{ key?: string }>;
    if (entries.some(e => e?.key === key)) {
      const rel = (catalog as any).releases.find((r: any) => r.slug === slug);
      if (rel && !isReleased(rel.release_date)) return null;
      return { slug };
    }
  }
  return null;
}

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

export const onRequestPost: PagesFunction<Env> = corsHandler<Env>(async ({ request, env }) => {
  // 20/min/IP — a real fan spends this once, ever; generous enough for
  // retries/double-clicks without opening a grinding surface.
  const rl = await rateLimit(env, 'freetoken', 'ip', clientIp(request), 20, 60);
  if (!rl.ok) return rateLimitedJson(rl);

  const cookie =
    readCookie(request, SESSION_COOKIE) ||
    readCookie(request, LEGACY_SESSION_COOKIE) ||
    '';
  const email = await verifySession(env.AUTH_SECRET, cookie, env);
  if (!email) return jsonRes({ error: 'unauthorized' }, 401);

  let body: any;
  try { body = await request.json(); } catch { return jsonRes({ error: 'invalid body' }, 400); }
  const key = typeof body?.key === 'string' ? body.key : '';
  const resolved = resolveMasterKey(key);
  if (!resolved) return jsonRes({ error: 'invalid track' }, 400);

  let record = await getCustomerRecord(env, email);
  if (!record) return jsonRes({ error: 'no account' }, 403);
  if (!record.free_token_granted_at) return jsonRes({ error: 'no token' }, 403);

  if (record.free_token_spent_key) {
    // Idempotent replay of the winning key succeeds; any other key is a
    // genuine second-spend attempt and is refused.
    if (record.free_token_spent_key === key) return jsonRes({ ok: true, key });
    return jsonRes({ error: 'already spent' }, 409);
  }

  // Re-read + re-check right before the write to narrow the double-submit
  // race — see file header comment for what this does and doesn't guarantee.
  record = (await getCustomerRecord(env, email)) || record;
  if (record.free_token_spent_key) {
    if (record.free_token_spent_key === key) return jsonRes({ ok: true, key });
    return jsonRes({ error: 'already spent' }, 409);
  }

  record.free_token_spent_key = key;
  record.free_token_spent_at = Math.floor(Date.now() / 1000);
  await saveCustomerRecord(env, record);

  return jsonRes({ ok: true, key });
});
