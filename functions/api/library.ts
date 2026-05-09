// GET /api/library  — returns the logged-in customer's full order history,
// joined with the music catalog + masters manifest so /library can render
// download buttons without separately calling the catalog endpoints.
import { readCookie, verifySession, SESSION_COOKIE, LEGACY_SESSION_COOKIE } from '../_lib/auth';
import { corsHandler, preflight } from '../_lib/cors';
import manifest from '../../src/data/masters-manifest.json';
import catalog from '../../src/data/music-catalog.json';

interface CustomerRecord {
  email: string;
  name?: string | null;
  first_seen_at: number;
  last_seen_at: number;
  purchases: Array<{
    purchased_at: number;
    stripe_session_id: string;
    music_release_slugs: string[];
    merch_items: Array<{ printful_variant_id?: number; quantity: number }>;
    amount_total: number;
    currency: string;
  }>;
}

interface Env {
  AUTH_SECRET: string;
  DOWNLOADS: KVNamespace;
}

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

export const onRequestGet: PagesFunction<Env> = corsHandler<Env>(async ({ request, env }) => {
  const cookie =
    readCookie(request, SESSION_COOKIE) ||
    readCookie(request, LEGACY_SESSION_COOKIE) ||
    '';
  const email = await verifySession(env.AUTH_SECRET, cookie, env);
  if (!email) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  const raw = await env.DOWNLOADS.get(`customer:${email}`);
  if (!raw) {
    return new Response(JSON.stringify({ email, purchases: [], releases: [] }), { headers: { 'Content-Type': 'application/json' } });
  }
  let record: CustomerRecord;
  try { record = JSON.parse(raw); } catch { record = { email, first_seen_at: 0, last_seen_at: 0, purchases: [] } as CustomerRecord; }

  // Roll up music releases the customer has access to (deduped across orders).
  const ownedSlugs = new Set<string>();
  for (const p of record.purchases || []) {
    for (const slug of (p.music_release_slugs || [])) ownedSlugs.add(slug);
  }
  const releases = (catalog as any).releases
    .filter((r: any) => ownedSlugs.has(r.slug))
    .map((r: any) => ({
      slug: r.slug,
      title: r.title,
      type: r.type,
      artwork: r.artwork,
      track_count: r.track_count,
      files: ((manifest as any).releases?.[r.slug] || []),
    }));

  // Strip stripe_session_id and merch_items from the client-facing payload —
  // they're operational identifiers the page never renders.
  const purchases = (record.purchases || []).map(p => ({
    purchased_at: p.purchased_at,
    music_release_slugs: p.music_release_slugs,
    amount_total: p.amount_total,
    currency: p.currency,
  }));

  return new Response(JSON.stringify({
    email: record.email,
    name: record.name || null,
    first_seen_at: record.first_seen_at,
    purchases,
    releases,
  }), { headers: { 'Content-Type': 'application/json' } });
});
