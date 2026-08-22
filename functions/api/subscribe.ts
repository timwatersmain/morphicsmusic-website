// POST /api/subscribe — join the mailing list.
// Body: { email, source?, website? }
//
// Two stores, on purpose, because they answer different questions:
//
//   Cloudflare KV  — the CAPTURE log. Who gave us an address, when, and from
//                    which page. Ours, permanent, and the thing the brain
//                    syncs down. Survives us ever leaving Resend.
//   Resend topic   — the live SUBSCRIPTION STATE. Whether this person still
//                    wants mail. It has to live there because that is where
//                    the unsubscribe link in every newsletter points, and a
//                    status we keep separately would be wrong the moment
//                    someone clicks it.
//
// So KV is never consulted to decide whether to send, and Resend is never
// consulted to decide where a subscriber came from. Neither is a cache of the
// other.
//
// Single opt-in, deliberately: a confirmation round trip loses a large share
// of real signups, and this list is small and low-risk. The abuse that opens
// up — signing someone else up — is mitigated by the rate limit, the
// honeypot, and a welcome email that carries an unsubscribe link, so the
// wrongly-added recipient always has a one-click exit.

import { corsHandler, preflight } from '../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../_lib/ratelimit';
import { sendWelcomeEmail } from '../_lib/emails';

interface Env {
  DOWNLOADS: KVNamespace;
  RESEND_API_KEY?: string;
  RESEND_TOPIC_ID?: string;
  ORDER_FROM_EMAIL?: string;
  PUBLIC_SITE_URL?: string;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Deliberately permissive. This is a format sniff to catch typos and obvious
// junk, not an attempt to implement RFC 5322 — over-strict patterns reject
// real addresses (plus-tags, new TLDs, unicode locals) and the only real proof
// an address works is mail arriving at it.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

export const subscriberKey = (email: string) => `subscriber:${email}`;

// Resend is best-effort from the caller's point of view: if it fails we still
// have the address in KV and can replay it. Throwing here would lose the
// signup entirely to protect a side effect, which is the wrong trade.
async function addToResendTopic(env: Env, email: string): Promise<{ ok: boolean; detail?: string }> {
  if (!env.RESEND_API_KEY || !env.RESEND_TOPIC_ID) {
    return { ok: false, detail: 'resend not configured' };
  }
  const res = await fetch('https://api.resend.com/contacts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      topics: [{ id: env.RESEND_TOPIC_ID, subscription: 'opt_in' }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('resend contact create failed:', res.status, detail);
    return { ok: false, detail: `${res.status} ${detail}`.slice(0, 300) };
  }
  return { ok: true };
}

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

export const onRequestPost: PagesFunction<Env> = corsHandler<Env>(async ({ request, env, waitUntil }) => {
  // 5 per IP per 10 min. A person subscribes once; this is enough for a
  // fat-fingered retry and tight enough that the endpoint is not a usable
  // way to mail-bomb a stranger.
  const rl = await rateLimit(env, 'subscribe', 'ip', clientIp(request), 5, 600);
  if (!rl.ok) return rateLimitedJson(rl);

  let body: any;
  try { body = await request.json(); } catch { return jsonRes({ error: 'invalid body' }, 400); }

  // Honeypot. A field hidden from people but not from naive bots; anything
  // that fills it gets the success response and no record, so the bot has no
  // signal to adapt to.
  if (typeof body?.website === 'string' && body.website.trim() !== '') {
    return jsonRes({ ok: true });
  }

  const email = normaliseEmail(body?.email);
  if (!email) return jsonRes({ error: 'invalid email' }, 400);

  const source = typeof body?.source === 'string' ? body.source.slice(0, 60) : 'site';
  const now = Math.floor(Date.now() / 1000);

  const existingRaw = await env.DOWNLOADS.get(subscriberKey(email));
  let record: any;
  if (existingRaw) {
    try { record = JSON.parse(existingRaw); } catch { record = null; }
  }
  const isNew = !record;
  record = record || { email, first_seen_at: now, source };
  record.last_seen_at = now;
  // No TTL — this is a permanent record of consent, and the date someone
  // opted in is exactly what you need if a complaint ever has to be answered.
  await env.DOWNLOADS.put(subscriberKey(email), JSON.stringify(record));

  // Only on the first signup. A repeat submit re-affirms the opt-in in Resend
  // (harmless, and it revives someone who unsubscribed then changed their
  // mind) but must not send a second welcome.
  waitUntil((async () => {
    await addToResendTopic(env, email);
    if (isNew) await sendWelcomeEmail(env, email);
  })());

  // The same response either way. Telling a stranger whether an address is
  // already subscribed turns this into a way to test whether someone is on
  // the list.
  return jsonRes({ ok: true });
});
