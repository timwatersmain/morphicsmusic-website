// GET  /api/unsubscribe?e=<email>&t=<sig>  — clicked from an email
// POST /api/unsubscribe                    — one-click (RFC 8058), same params
//
// Both verbs exist because mail clients use both. A human clicking the link in
// the footer sends a GET and should land on a page that says it worked; Gmail
// and Apple Mail's "Unsubscribe" button sends a POST to the URL in the
// List-Unsubscribe header and shows the user nothing. If only the GET existed,
// the button in the client would appear to do nothing.
//
// No session, no expiry: the link is clicked months later, on another device,
// often by someone who never had an account. A dead unsubscribe link is a spam
// complaint, which costs far more than the link staying valid forever.

import { verifyUnsubscribe } from '../_lib/auth';
import { subscriberKey, normaliseEmail } from '../_lib/newsletter';

interface Env {
  DOWNLOADS: KVNamespace;
  AUTH_SECRET: string;
  RESEND_API_KEY?: string;
  RESEND_TOPIC_ID?: string;
}

// Resend holds the subscription state that actually gates sending, so this is
// the write that matters. The KV flag below is bookkeeping for the brain sync.
async function optOutInResend(env: Env, email: string): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.RESEND_TOPIC_ID) return false;
  const res = await fetch(`https://api.resend.com/contacts/${encodeURIComponent(email)}/topics`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ topics: [{ id: env.RESEND_TOPIC_ID, subscription: 'opt_out' }] }),
  });
  if (!res.ok) console.error('resend opt_out failed:', res.status, await res.text().catch(() => ''));
  return res.ok;
}

async function doUnsubscribe(env: Env, url: URL): Promise<boolean> {
  const email = normaliseEmail(url.searchParams.get('e'));
  const token = url.searchParams.get('t') || '';
  if (!email) return false;
  if (!(await verifyUnsubscribe(env.AUTH_SECRET, email, token))) return false;

  await optOutInResend(env, email);

  // Keep the capture record rather than deleting it. Someone who unsubscribed
  // must not be silently re-added by a later bulk import, and only a tombstone
  // can tell you that. Deleting the row loses the fact that they said no.
  const raw = await env.DOWNLOADS.get(subscriberKey(email));
  if (raw) {
    try {
      const rec = JSON.parse(raw);
      rec.unsubscribed_at = Math.floor(Date.now() / 1000);
      await env.DOWNLOADS.put(subscriberKey(email), JSON.stringify(rec));
    } catch { /* a malformed record must not block the opt-out */ }
  }
  return true;
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${title}</title>
     <style>body{background:#0a0a0f;color:#e8e8ec;font-family:-apple-system,sans-serif;
     display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
     div{max-width:32rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .75rem}
     p{opacity:.7;line-height:1.6;margin:0 0 1.5rem}
     a{color:#00f0ff;font-size:.75rem;letter-spacing:.1em;text-transform:uppercase}</style>
     </head><body><div><h1>${title}</h1><p>${body}</p>
     <a href="https://morphicsmusic.com">morphicsmusic.com</a></div></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const ok = await doUnsubscribe(env, new URL(request.url));
  return ok
    ? page('Unsubscribed.', "You won't get the newsletter again. Nothing else changes — any music you own is still in your library.")
    : page('That link didn\'t work.', 'It may have been altered in transit. Reply to any email from us and you\'ll be removed by hand.', 400);
};

// RFC 8058 one-click. The client shows no page, so the body is irrelevant —
// only the status matters. It must never require a confirmation step: that is
// the entire point of the header.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const ok = await doUnsubscribe(env, new URL(request.url));
  return new Response(ok ? 'ok' : 'invalid', { status: ok ? 200 : 400 });
};
