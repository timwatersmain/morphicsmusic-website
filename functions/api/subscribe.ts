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
import { subscribeToNewsletter, normaliseEmail, subscriberKey } from '../_lib/newsletter';

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

  // The shared path — same KV record, same Resend push, same welcome mail as
  // the opt-in checkbox on signup. waitUntil so a slow provider never holds
  // the visitor on a spinner for a write that has already happened.
  waitUntil(subscribeToNewsletter(env, email, source));

  // The same response either way. Telling a stranger whether an address is
  // already subscribed turns this into a way to test whether someone is on
  // the list.
  return jsonRes({ ok: true });
});
