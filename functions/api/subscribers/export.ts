// GET /api/subscribers/export — the full mailing list, for MorphicsBrain.
// Auth: X-Export-Token, compared against SUBSCRIBERS_EXPORT_TOKEN.
//
// This exists because the sync only runs in one direction. Cloudflare cannot
// write to the brain's SQLite file — it is on a machine at home, and
// sync-from-brain.mjs reads it as a local file — so the brain has to come and
// fetch. This is that door, and it is the only one: nothing else exposes the
// list.
//
// It merges the two stores rather than trusting either alone. KV knows where
// and when someone signed up; Resend knows whether they still want mail. A row
// here is only complete with both, and a person can legitimately appear in one
// and not the other:
//
//   KV only     — Resend was down or unconfigured when they signed up. They
//                 are a real subscriber we have failed to register, and this
//                 is where you would notice.
//   Resend only — added directly in the Resend dashboard, or imported. Real,
//                 but with no source attribution to give.
//
// So the export never drops a row for being in one store, and marks which.

import { signUnsubscribe } from '../../_lib/auth';

interface Env {
  DOWNLOADS: KVNamespace;
  SUBSCRIBERS_EXPORT_TOKEN?: string;
  AUTH_SECRET: string;
  PUBLIC_SITE_URL?: string;
  RESEND_API_KEY?: string;
  RESEND_TOPIC_ID?: string;
}

function constantTimeEqual(a: string, b: string): boolean {
  // Compare as bytes and always walk the full length of the longer string, so
  // neither the token's length nor its first differing character is leaked by
  // how long this takes.
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const len = Math.max(ab.length, bb.length);
  let r = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) r |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return r === 0;
}

async function allKvSubscribers(env: Env): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  let cursor: string | undefined;
  // KV list pages at 1000 keys. Without this loop the export would silently
  // stop at the first page — the brain would look synced and simply be missing
  // everyone after the thousandth signup.
  do {
    const page: any = await env.DOWNLOADS.list({ prefix: 'subscriber:', cursor, limit: 1000 });
    for (const k of page.keys) {
      const raw = await env.DOWNLOADS.get(k.name);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw);
        if (rec?.email) out.set(String(rec.email).toLowerCase(), rec);
      } catch { /* skip a corrupt row rather than fail the whole export */ }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

async function allResendContacts(env: Env): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  if (!env.RESEND_API_KEY) return out;
  const res = await fetch('https://api.resend.com/contacts?limit=1000', {
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
  });
  if (!res.ok) {
    console.error('resend contact list failed:', res.status);
    return out;
  }
  const body: any = await res.json().catch(() => ({}));
  for (const c of (body?.data || [])) {
    if (c?.email) out.set(String(c.email).toLowerCase(), c);
  }
  return out;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const given = request.headers.get('X-Export-Token') || '';
  // An unset token means the endpoint is CLOSED, never open. Defaulting to
  // open when unconfigured is how a list ends up publicly downloadable.
  if (!env.SUBSCRIBERS_EXPORT_TOKEN || !constantTimeEqual(given, env.SUBSCRIBERS_EXPORT_TOKEN)) {
    return new Response('unauthorized', { status: 401 });
  }

  const [kv, resend] = await Promise.all([allKvSubscribers(env), allResendContacts(env)]);

  const site = env.PUBLIC_SITE_URL || 'https://morphicsmusic.com';
  const emails = new Set<string>([...kv.keys(), ...resend.keys()]);
  const rows = await Promise.all([...emails].sort().map(async email => {
    const k = kv.get(email);
    const r = resend.get(email);
    return {
      email,
      source: k?.source || (r ? 'resend' : null),
      first_seen_at: k?.first_seen_at ?? null,
      // EITHER store saying "unsubscribed" is enough. Not "whichever is more
      // authoritative" — there is no safe way to be wrong here. Emailing
      // someone who opted out is the failure that costs a domain its
      // reputation, while skipping someone who is actually still subscribed
      // costs one newsletter. So the two are ORed, and the fail-safe
      // direction is the one that sends less.
      unsubscribed: (r ? !!r.unsubscribed : false) || !!k?.unsubscribed_at,
      unsubscribed_at: k?.unsubscribed_at ?? null,
      // Minted here so AUTH_SECRET never has to exist on the sending machine.
      // The local sender needs a working per-recipient unsubscribe link in
      // every email it puts out; handing it the signing key instead would
      // spread the secret that also signs session cookies onto a laptop.
      unsubscribe_url: `${site}/api/unsubscribe?e=${encodeURIComponent(email)}&t=${await signUnsubscribe(env.AUTH_SECRET, email)}`,
      in_kv: !!k,
      in_resend: !!r,
    };
  }));

  return new Response(JSON.stringify({
    generated_at: Math.floor(Date.now() / 1000),
    count: rows.length,
    subscribed: rows.filter(r => !r.unsubscribed).length,
    subscribers: rows,
  }), {
    headers: {
      'Content-Type': 'application/json',
      // Never let a CDN or browser hold a copy of the mailing list.
      'Cache-Control': 'private, no-store',
    },
  });
};
