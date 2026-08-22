// POST /api/claim — take ownership of a FREE digital product.
// Body: { digital_slug }
//
// Why this exists at all: Stripe Checkout cannot process a zero-amount payment
// (card charges have a ~$0.50 minimum), so a free product has no path through
// api/checkout.ts — a $0 line item is an API error, not a free order. Free
// therefore needs its own door, and this is it.
//
// The important consequence of that: this endpoint MINTS AN ENTITLEMENT WITH
// NO PAYMENT. Everything below exists to keep that narrow.
//
//   - a session is required, so ownership always attaches to a real account
//     (which is also the only way it can show up in /library)
//   - the product must be free IN THE CATALOGUE. The price is never read from
//     the request, so no body can turn a paid product into a free one
//   - the product must be sellable — on sale, or an opted-in pre-order. A
//     withdrawn product cannot be claimed just because its price is 0
//   - claiming twice is idempotent, and re-sends no email
//
// It grants ownership only. Delivery still answers to the release date in
// download.ts exactly as a paid pre-order does: a free pre-order is owned
// immediately and downloadable on release day, not before.

import digitalData from '../../src/data/digital.json';
import { digitalSellable, isDigitalPreorderable } from '../_lib/preorder.mjs';
import { readCookie, verifySession, SESSION_COOKIE, LEGACY_SESSION_COOKIE } from '../_lib/auth';
import { corsHandler, preflight } from '../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../_lib/ratelimit';
import { getCustomerRecord, getOrCreateCustomerRecord, saveCustomerRecord } from '../_lib/customer';
import { sendPreorderEmail } from '../_lib/emails';

interface Env {
  AUTH_SECRET: string;
  DOWNLOADS: KVNamespace;
  RESEND_API_KEY?: string;
  ORDER_FROM_EMAIL?: string;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

export const onRequestPost: PagesFunction<Env> = corsHandler<Env>(async ({ request, env, waitUntil }) => {
  // 10/min/IP. A person claims a given product once, ever; this is generous
  // for a double-click and tight enough that the endpoint is not worth
  // grinding against.
  const rl = await rateLimit(env, 'claim', 'ip', clientIp(request), 10, 60);
  if (!rl.ok) return rateLimitedJson(rl);

  const cookie =
    readCookie(request, SESSION_COOKIE) ||
    readCookie(request, LEGACY_SESSION_COOKIE) ||
    '';
  const email = await verifySession(env.AUTH_SECRET, cookie, env);
  // 401 is load-bearing for the UI: the button turns into "sign in to claim"
  // on this exact response rather than guessing the state up front.
  if (!email) return jsonRes({ error: 'unauthorized' }, 401);

  let body: any;
  try { body = await request.json(); } catch { return jsonRes({ error: 'invalid body' }, 400); }
  const slug = typeof body?.digital_slug === 'string' ? body.digital_slug : '';

  const product = (digitalData as any[]).find(p => p.slug === slug);
  if (!product) return jsonRes({ error: 'unknown product' }, 404);
  // Price comes from the catalogue and only the catalogue.
  if (product.price_cents !== 0) return jsonRes({ error: 'not free' }, 403);
  if (!digitalSellable(product)) return jsonRes({ error: 'unavailable' }, 403);

  // getOrCreate, not get. A customer record is written by signup and by the
  // Stripe webhook, so someone who signed in by magic link and has never
  // bought anything has NO record — and refusing them here would dead-end the
  // exact person a free product is aimed at. A verified session is proof of
  // identity; this record is only the ownership ledger, so opening one on
  // first claim is the correct move rather than an error.
  let record = await getOrCreateCustomerRecord(env, email);

  const alreadyOwns = (r: any) =>
    (r?.purchases || []).some((p: any) => (p.digital_slugs || []).includes(slug));

  // Idempotent: a replayed claim is a success, not a second grant and not an
  // error. A double-clicked button must not produce two purchase rows, and
  // must not send a second email.
  if (alreadyOwns(record)) return jsonRes({ ok: true, slug, already: true });

  // Re-read immediately before the write to narrow the double-submit window.
  // KV has no compare-and-swap, so this narrows rather than closes it — see
  // the same reasoning, at length, in free-token.ts. The residual race here
  // costs a duplicate purchase row for a $0 item, which is cosmetic: ownership
  // is a set, so owning the slug twice is owning it once.
  record = (await getCustomerRecord(env, email)) || record;
  if (alreadyOwns(record)) return jsonRes({ ok: true, slug, already: true });

  record.purchases = record.purchases || [];
  record.purchases.push({
    purchased_at: Math.floor(Date.now() / 1000),
    // Not a Stripe order, and the record's shape wants a string here. A
    // marker rather than a blank so a free claim is identifiable in the
    // order history at a glance, and can never be mistaken for a session id.
    stripe_session_id: `free:${slug}`,
    music_release_slugs: [],
    digital_slugs: [slug],
    merch_items: [],
    amount_total: 0,
    currency: 'usd',
  });
  record.last_seen_at = Math.floor(Date.now() / 1000);
  await saveCustomerRecord(env, record);

  // The write is what matters; the email is best-effort. Sending it inside
  // waitUntil means a Resend outage cannot fail a claim that already
  // succeeded — the product is in their library either way.
  const preorder = isDigitalPreorderable(product.slug, product.release_date);
  if (preorder) {
    waitUntil(sendPreorderEmail(env, email, [{ title: product.name, date: product.release_date || '' }]));
  }

  return jsonRes({ ok: true, slug, preorder, release_date: product.release_date || '' });
});
