// /api/download
//   GET ?token=...&action=list   → JSON: { releases: [...] }
//   GET ?token=...&key=<r2-key>  → streams the file
//   GET ?key=<r2-key>            → ALSO works if the caller has a valid
//                                  session cookie + the slug is in their
//                                  customer record. No expiry, no use cap.
//
// Email-link tokens stay 7-day / 5-use; logged-in customers download freely.

import manifest from '../../src/data/masters-manifest.json';
import digitalData from '../../src/data/digital.json';
import catalog from '../../src/data/music-catalog.json';
import { isReleased } from '../_lib/release-gate.mjs';
import { digitalDeliverable } from '../_lib/preorder.mjs';
import { readCookie, verifySession, SESSION_COOKIE, LEGACY_SESSION_COOKIE } from '../_lib/auth';
import { corsHandler, preflight } from '../_lib/cors';
import { rateLimit, rateLimitedText, clientIp } from '../_lib/ratelimit';

interface CustomerRecord {
  purchases?: Array<{ music_release_slugs?: string[]; digital_slugs?: string[] }>;
  // Free-song token bookkeeping (functions/_lib/customer.ts is the source of
  // truth for the shape). Only spent_key is read here, and only as an
  // additive, exact-file-key entitlement — see the check below.
  free_token_spent_key?: string;
}

interface DownloadGrant {
  email: string;
  release_slugs: string[];
  digital_slugs?: string[];
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
function parseAndValidateDigitalKey(key: string): { slug: string; filename: string } | null {
  if (!key || key.length > 256 || key.includes('\0') || key.includes('\\')) return null;
  const product = (digitalData as any[]).find(p => p?.file?.r2_key === key);
  if (!product) return null;
  return { slug: product.slug, filename: product.file.filename || 'download' };
}

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
  // 60/min/IP — covers a full album re-download (10-20 tracks) without
  // tripping for a real buyer; bots scraping the endpoint hit it fast.
  const rl = await rateLimit(env, 'download', 'ip', clientIp(request), 60, 60);
  if (!rl.ok) return rateLimitedText(rl);

  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const action = url.searchParams.get('action');
  const key = url.searchParams.get('key');

  // Cookie-authenticated path (logged-in customer hitting /library files).
  if (!token && key) {
    const cookie =
      readCookie(request, SESSION_COOKIE) ||
      readCookie(request, LEGACY_SESSION_COOKIE) ||
      '';
    const email = await verifySession(env.AUTH_SECRET, cookie, env);
    if (!email) return new Response('unauthorized', { status: 401 });
    const raw = await env.DOWNLOADS.get(`customer:${email}`);
    if (!raw) return new Response('no purchases', { status: 403 });
    let rec: CustomerRecord;
    try { rec = JSON.parse(raw); } catch { return new Response('corrupt record', { status: 500 }); }
    // Digital products (fonts, packs, plugins) have their own allow-list and,
    // since pre-orders, their own release-date gate too. Most digital products
    // carry no release_date and are delivered on purchase exactly as before —
    // only one that states a date is held to it.
    const digital = parseAndValidateDigitalKey(key);
    const parsed = digital || parseAndValidateKey(key, manifest);
    if (!parsed) return new Response('invalid key', { status: 400 });
    const owned = new Set<string>();
    if (digital) {
      // The delivery half of a digital pre-order. Without this the buyer
      // would own the slug the instant they paid and could pull the file
      // immediately, which is the whole thing a pre-order must not do.
      const dProduct = (digitalData as any[]).find(p => p.slug === digital.slug);
      if (!digitalDeliverable(dProduct)) {
        return new Response('not yet released', { status: 403 });
      }
      for (const p of (rec.purchases || [])) for (const d of (p.digital_slugs || [])) owned.add(d);
    } else {
      const rel = (catalog as any).releases.find((r: any) => r.slug === parsed.slug);
      if (rel && !isReleased(rel.release_date)) {
        return new Response('not yet released', { status: 403 });
      }
      for (const p of (rec.purchases || [])) for (const s of (p.music_release_slugs || [])) owned.add(s);
    }
    // Additive second way to be entitled, layered on top of the ownership
    // check above (which is untouched): a fan who spent their free-song
    // token on THIS EXACT file key may download it, same as a purchase.
    // This is never a release-level grant — parsed.slug alone is not
    // enough, the R2 key itself must match what they redeemed, and it only
    // ever applies to music masters (digital products aren't in scope for
    // the free-song token).
    const freeSongMatch = !digital && rec.free_token_spent_key === key;
    if (!owned.has(parsed.slug) && !freeSongMatch) {
      return new Response('not in your library', { status: 403 });
    }
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
    const digitals = (digitalData as any[])
      .filter(d => (grant.digital_slugs || []).includes(d.slug))
      .map(d => ({
        slug: d.slug,
        title: d.name,
        artwork: d.thumbnail,
        preorder: !digitalDeliverable(d),
        release_date: d.release_date || '',
        // A pre-order lists no key. The download of that key would 403 two
        // lines further down anyway; publishing it here would only produce a
        // link that exists to fail.
        files: digitalDeliverable(d) ? [{ key: d.file.r2_key, filename: d.file.filename }] : [],
      }));
    return new Response(JSON.stringify({
      email: grant.email,
      expires_at: grant.expires_at,
      uses: grant.uses,
      max_uses: MAX_USES,
      releases,
      digitals,
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (!key) return new Response('missing key', { status: 400 });

  // Validate key shape AND that the file is actually in the manifest.
  // Path-traversal segments are rejected before we ever touch R2.
  const digital = parseAndValidateDigitalKey(key);
  const parsed = digital || parseAndValidateKey(key, manifest);
  if (!parsed) return new Response('invalid key', { status: 400 });
  if (digital) {
    // Same gate as the cookie path above. A token grant is a second door into
    // the same files, so it needs the same lock — a pre-order that is blocked
    // for signed-in buyers but open via an emailed link is not blocked.
    const dProduct = (digitalData as any[]).find(p => p.slug === digital.slug);
    if (!digitalDeliverable(dProduct)) {
      return new Response('not yet released', { status: 403 });
    }
    if (!(grant.digital_slugs || []).includes(parsed.slug)) {
      return new Response('not in your grant', { status: 403 });
    }
  } else {
    const rel = (catalog as any).releases.find((r: any) => r.slug === parsed.slug);
    if (rel && !isReleased(rel.release_date)) {
      return new Response('not yet released', { status: 403 });
    }
    if (!grant.release_slugs.includes(parsed.slug)) {
      return new Response('not in your grant', { status: 403 });
    }
  }

  if (grant.uses >= MAX_USES) {
    return new Response('download limit reached', { status: 429 });
  }

  // Debounce duplicate requests for the same token+key pair: link-preview
  // bots (Slack/Discord/Gmail) often pre-fetch URLs the user shares, which
  // would otherwise burn the 5-use quota before the buyer ever clicks.
  // Within a 60s window we serve the file but skip the counter bump.
  const debounceKey = `dl_recent:${token}:${parsed.slug}/${parsed.filename}`;
  const recent = await env.DOWNLOADS.get(debounceKey);

  if (!recent) {
    // Increment uses BEFORE serving the file. KV has no CAS, so concurrent
    // requests with the same token can each see uses=N and all pass the
    // gate; the cap is therefore best-effort. Bumping pre-stream at least
    // makes sequential requests respect the limit and shrinks the race
    // window versus the previous post-stream order.
    grant.uses += 1;
    await env.DOWNLOADS.put(`grant:${token}`, JSON.stringify(grant), {
      expirationTtl: Math.max(60, grant.expires_at - Math.floor(Date.now() / 1000)),
    });
    await env.DOWNLOADS.put(debounceKey, '1', { expirationTtl: 60 });
  }

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
