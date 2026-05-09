// /api/download
//   GET ?token=...&action=list   → JSON: { releases: [...] }
//   GET ?token=...&key=<r2-key>  → streams the file
//   GET ?key=<r2-key>            → ALSO works if the caller has a valid
//                                  session cookie + the slug is in their
//                                  customer record. No expiry, no use cap.
//
// Email-link tokens stay 7-day / 5-use; logged-in customers download freely.

import manifest from '../../src/data/masters-manifest.json';
import catalog from '../../src/data/music-catalog.json';
import { readCookie, verifySession } from '../_lib/auth';
import { corsHandler, preflight } from '../_lib/cors';

interface CustomerRecord {
  purchases?: Array<{ music_release_slugs?: string[] }>;
}

interface DownloadGrant {
  email: string;
  release_slugs: string[];
  created_at: number;
  expires_at: number;
  uses: number;
}

interface Env {
  DOWNLOADS: KVNamespace;
  MASTERS: R2Bucket;
  AUTH_SECRET: string;
}

const MAX_USES = 5;

const MIME: Record<string, string> = {
  flac: 'audio/flac',
  wav: 'audio/wav',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  mp3: 'audio/mpeg',
};

async function loadGrant(env: Env, token: string): Promise<DownloadGrant | null> {
  const raw = await env.DOWNLOADS.get(`grant:${token}`);
  if (!raw) return null;
  const g: DownloadGrant = JSON.parse(raw);
  if (g.expires_at < Math.floor(Date.now() / 1000)) return null;
  return g;
}

// Validate an R2 master key is well-formed and the requested file is one
// the manifest actually publishes for that release. Rejects path-traversal
// segments ('', '.', '..', backslashes, NULs) before we ever touch R2, and
// requires the full key to match an exact manifest entry — that's the
// authoritative allow-list. Returns the verified slug + display filename
// (which may differ from the URL-safe segment) or null on any failure.
function parseAndValidateKey(key: string, manifestRef: any): { slug: string; filename: string } | null {
  if (!key || key.length > 256 || key.includes('\0') || key.includes('\\')) return null;
  const parts = key.split('/');
  if (parts.length !== 3) return null;
  if (parts[0] !== 'masters') return null;
  const [, slug, keyTail] = parts;
  if (!slug || !keyTail) return null;
  for (const seg of [slug, keyTail]) {
    if (seg === '.' || seg === '..' || seg.startsWith('.')) return null;
  }
  const entries = (manifestRef.releases?.[slug] || []) as Array<{ key?: string; filename?: string }>;
  const match = entries.find(e => e?.key === key);
  if (!match) return null;
  return { slug, filename: match.filename || keyTail };
}

// Sanitize a filename for the Content-Disposition header so a crafted
// manifest entry can't break out of the quoted value with a stray ", \r,
// or \n. Allow-list ASCII word chars, dot, dash, space.
function safeContentDispositionName(filename: string): string {
  return filename.replace(/[^\w.\- ]/g, '_').slice(0, 128) || 'download';
}

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

export const onRequestGet: PagesFunction<Env> = corsHandler<Env>(async ({ request, env }) => {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const action = url.searchParams.get('action');
  const key = url.searchParams.get('key');

  // Cookie-authenticated path (logged-in customer hitting /library files).
  if (!token && key) {
    const cookie = readCookie(request, 'morphics_auth') || '';
    const email = await verifySession(env.AUTH_SECRET, cookie);
    if (!email) return new Response('unauthorized', { status: 401 });
    const raw = await env.DOWNLOADS.get(`customer:${email}`);
    if (!raw) return new Response('no purchases', { status: 403 });
    let rec: CustomerRecord;
    try { rec = JSON.parse(raw); } catch { return new Response('corrupt record', { status: 500 }); }
    const parsed = parseAndValidateKey(key, manifest);
    if (!parsed) return new Response('invalid key', { status: 400 });
    const owned = new Set<string>();
    for (const p of (rec.purchases || [])) for (const s of (p.music_release_slugs || [])) owned.add(s);
    if (!owned.has(parsed.slug)) return new Response('not in your library', { status: 403 });
    const obj = await env.MASTERS.get(key);
    if (!obj) return new Response('file not found', { status: 404 });
    const ext = (parsed.filename.split('.').pop() || '').toLowerCase();
    const filename = safeContentDispositionName(parsed.filename);
    return new Response(obj.body, {
      headers: {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': String(obj.size),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  if (!token) return new Response('missing token', { status: 400 });

  const grant = await loadGrant(env, token);
  if (!grant) return new Response('expired or invalid', { status: 404 });

  if (action === 'list' || (!key && !action)) {
    const slugs = new Set(grant.release_slugs);
    const releases = (catalog as any).releases
      .filter((r: any) => slugs.has(r.slug))
      .map((r: any) => ({
        slug: r.slug,
        title: r.title,
        artwork: r.artwork,
        files: ((manifest as any).releases[r.slug] || []),
      }));
    return new Response(JSON.stringify({
      email: grant.email,
      expires_at: grant.expires_at,
      uses: grant.uses,
      max_uses: MAX_USES,
      releases,
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (!key) return new Response('missing key', { status: 400 });

  // Validate key shape AND that the file is actually in the manifest.
  // Path-traversal segments are rejected before we ever touch R2.
  const parsed = parseAndValidateKey(key, manifest);
  if (!parsed) return new Response('invalid key', { status: 400 });
  if (!grant.release_slugs.includes(parsed.slug)) {
    return new Response('not in your grant', { status: 403 });
  }

  if (grant.uses >= MAX_USES) {
    return new Response('download limit reached', { status: 429 });
  }

  // Increment uses BEFORE serving the file. KV has no CAS, so concurrent
  // requests with the same token can each see uses=N and all pass the gate;
  // the cap is therefore best-effort. Bumping pre-stream at least makes
  // sequential requests respect the limit and shrinks the race window
  // versus the previous post-stream order.
  grant.uses += 1;
  await env.DOWNLOADS.put(`grant:${token}`, JSON.stringify(grant), {
    expirationTtl: Math.max(60, grant.expires_at - Math.floor(Date.now() / 1000)),
  });

  const obj = await env.MASTERS.get(key);
  if (!obj) return new Response('file not found', { status: 404 });

  const ext = (parsed.filename.split('.').pop() || '').toLowerCase();
  const filename = safeContentDispositionName(parsed.filename);
  return new Response(obj.body, {
    headers: {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
});
