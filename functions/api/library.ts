// GET /api/library  — returns the logged-in customer's full order history,
// joined with the music catalog + masters manifest so /library can render
// download buttons without separately calling the catalog endpoints.
import { readCookie, verifySession, SESSION_COOKIE, LEGACY_SESSION_COOKIE } from '../_lib/auth';
import { corsHandler, preflight } from '../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../_lib/ratelimit';
import { isReleased } from '../_lib/release-gate.mjs';
import { daysUntilUnlock } from '../_lib/preorder.mjs';
import { ownedDigital } from '../_lib/entitlements';
import manifest from '../../src/data/masters-manifest.json';
import catalog from '../../src/data/music-catalog.json';
import digitalData from '../../src/data/digital.json';

interface CustomerRecord {
  email: string;
  name?: string | null;
  first_seen_at: number;
  last_seen_at: number;
  purchases: Array<{
    purchased_at: number;
    stripe_session_id: string;
    music_release_slugs: string[];
    digital_slugs?: string[];
    merch_items: Array<{ printful_variant_id?: number; quantity: number }>;
    amount_total: number;
    currency: string;
  }>;
  // Free-song token fields — see functions/_lib/customer.ts for the
  // authoritative shape/doc comment.
  free_token_granted_at?: number;
  free_token_spent_key?: string;
}

interface Env {
  AUTH_SECRET: string;
  DOWNLOADS: KVNamespace;
}

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

export const onRequestGet: PagesFunction<Env> = corsHandler<Env>(async ({ request, env }) => {
  // 60/min/IP — generous; /library page render does one call, refresh costs one.
  const rl = await rateLimit(env, 'library', 'ip', clientIp(request), 60, 60);
  if (!rl.ok) return rateLimitedJson(rl);

  const cookie =
    readCookie(request, SESSION_COOKIE) ||
    readCookie(request, LEGACY_SESSION_COOKIE) ||
    '';
  const email = await verifySession(env.AUTH_SECRET, cookie, env);
  if (!email) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  const raw = await env.DOWNLOADS.get(`customer:${email}`);
  if (!raw) {
    return new Response(JSON.stringify({
      email, purchases: [], releases: [], digital: [],
      free_token: { granted: false, spent_key: null },
      free_song_choices: [],
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  let record: CustomerRecord;
  try { record = JSON.parse(raw); } catch { record = { email, first_seen_at: 0, last_seen_at: 0, purchases: [] } as CustomerRecord; }

  // Roll up music releases the customer has access to (deduped across orders).
  const ownedSlugs = new Set<string>();
  for (const p of record.purchases || []) {
    for (const slug of (p.music_release_slugs || [])) ownedSlugs.add(slug);
  }
  // A pre-ordered release is owned but not yet deliverable, and the library is
  // where the buyer looks to check that the money did something. So it is
  // listed — with no files. Not out of caution about the UI: download.ts
  // refuses an unreleased key regardless, so publishing the keys here could
  // only ever produce a button that 403s.
  const releases = (catalog as any).releases
    .filter((r: any) => ownedSlugs.has(r.slug))
    .map((r: any) => {
      const released = isReleased(r.release_date);
      return {
        slug: r.slug,
        title: r.title,
        type: r.type,
        artwork: r.artwork,
        track_count: r.track_count,
        release_date: r.release_date || '',
        preorder: !released,
        unlocks_in_days: released ? null : daysUntilUnlock(r.release_date),
        files: released ? ((manifest as any).releases?.[r.slug] || []) : [],
      };
    });

  // If the fan already spent their free-song token on a track from a
  // release they don't otherwise own, surface it as its own entry — with
  // ONLY that one redeemed file, never the whole release's files — so it
  // renders in "Your library" indistinguishable in function from a
  // purchase. If they own the release outright, the file is already in
  // there via the loop above and nothing further is needed.
  if (record.free_token_spent_key && !releases.some((r: any) => r.files.some((f: any) => f.key === record.free_token_spent_key))) {
    const manifestReleases = (manifest as any).releases || {};
    for (const slug of Object.keys(manifestReleases)) {
      const match = (manifestReleases[slug] as any[]).find(e => e?.key === record.free_token_spent_key);
      if (!match) continue;
      const rel = (catalog as any).releases.find((r: any) => r.slug === slug);
      if (rel) {
        releases.push({
          slug: rel.slug,
          title: rel.title,
          type: rel.type,
          artwork: rel.artwork,
          track_count: rel.track_count,
          files: [match],
          free_song: true,
        });
      }
      break;
    }
  }

  // Strip stripe_session_id and merch_items from the client-facing payload —
  // they're operational identifiers the page never renders.
  const purchases = (record.purchases || []).map(p => ({
    purchased_at: p.purchased_at,
    music_release_slugs: p.music_release_slugs,
    digital_slugs: p.digital_slugs || [],
    amount_total: p.amount_total,
    currency: p.currency,
  }));

  const freeToken = {
    granted: !!record.free_token_granted_at,
    spent_key: record.free_token_spent_key || null,
  };

  // Only build the full pick-a-track list when it's actually needed (token
  // granted, nothing chosen yet) — a spent or never-granted fan gets an
  // empty array instead of the whole catalogue on every profile load.
  let freeSongChoices: Array<{ slug: string; title: string; artwork: string; key: string; filename: string }> = [];
  if (freeToken.granted && !freeToken.spent_key) {
    for (const r of (catalog as any).releases) {
      if (!isReleased(r.release_date)) continue;
      for (const f of ((manifest as any).releases?.[r.slug] || [])) {
        freeSongChoices.push({ slug: r.slug, title: r.title, artwork: r.artwork, key: f.key, filename: f.filename });
      }
    }
  }

  return new Response(JSON.stringify({
    email: record.email,
    name: record.name || null,
    first_seen_at: record.first_seen_at,
    purchases,
    releases,
    // Digital products (typefaces, plugins, packs) the customer bought.
    // /api/download's cookie path has always served these to their owner
    // with no expiry and no use cap; until now nothing listed them, so a
    // buyer had no way back to the file after the emailed link aged out.
    digital: ownedDigital(record, digitalData as any),
    free_token: freeToken,
    free_song_choices: freeSongChoices,
  }), { headers: { 'Content-Type': 'application/json' } });
});
