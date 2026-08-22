// POST /api/stripe-webhook
// Verifies Stripe signature, then routes by event type:
//  - checkout.session.completed     → fulfill (Printful + download token + email)
//  - charge.refunded                → revoke download grant + prune customer record
//  - charge.dispute.created         → same revoke as refund (chargeback opened)
//  - charge.dispute.funds_withdrawn → same revoke (funds actually pulled)
//
// Stripe → set this URL in Dashboard → Developers → Webhooks. Listen for
// all four event types above. Copy the signing secret into STRIPE_WEBHOOK_SECRET.

import Stripe from 'stripe';

import digitalData from '../../src/data/digital.json';
import musicData from '../../src/data/music-catalog.json';

interface FulfillmentEntry {
  type: 'merch' | 'music';
  printful_variant_id?: number;
  quantity: number;
  retail_price?: number;
  release_slug?: string;
  digital_slug?: string;
  // Set by checkout for a music line bought before its release date. The
  // ORDER is complete; the delivery is not. Nothing here grants anything —
  // download.ts gates on the release date independently — this only decides
  // which email the buyer gets.
  preorder?: boolean;
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
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  PRINTFUL_API_KEY: string;
  RESEND_API_KEY: string;
  PUBLIC_SITE_URL?: string;
  ORDER_FROM_EMAIL?: string;
  DOWNLOADS: KVNamespace;
}

const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;

function tokenHex(bytes = 24) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createPrintfulOrder(env: Env, session: Stripe.Checkout.Session, items: FulfillmentEntry[]) {
  const ship = session.shipping_details;
  if (!ship?.address) throw new Error('No shipping address on session');
  const recipient = {
    name: ship.name,
    address1: ship.address.line1,
    address2: ship.address.line2 || undefined,
    city: ship.address.city,
    state_code: ship.address.state,
    country_code: ship.address.country,
    zip: ship.address.postal_code,
    email: session.customer_details?.email,
  };
  const body = {
    external_id: session.id,
    recipient,
    items: items
      .filter(i => i.type === 'merch')
      .map(i => ({
        sync_variant_id: i.printful_variant_id,
        quantity: i.quantity,
        retail_price: i.retail_price?.toFixed(2),
      })),
    confirm: true, // auto-submit for fulfillment
  };
  const res = await fetch('https://api.printful.com/orders', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.PRINTFUL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Printful ${res.status}: ${await res.text()}`);
  return await res.json();
}

function digitalTitle(slug: string): string {
  const p = (digitalData as any[]).find(d => d.slug === slug);
  return p?.name || slug.toUpperCase().replace(/-/g, ' ');
}

async function issueDownloadGrant(
  env: Env,
  email: string,
  releaseSlugs: string[],
  sessionId: string,
  digitalSlugs: string[] = [],
) {
  const token = tokenHex();
  const now = Math.floor(Date.now() / 1000);
  const grant: DownloadGrant = {
    email,
    release_slugs: releaseSlugs,
    digital_slugs: digitalSlugs,
    created_at: now,
    expires_at: now + SEVEN_DAYS_SEC,
    uses: 0,
  };
  await env.DOWNLOADS.put(`grant:${token}`, JSON.stringify(grant), {
    expirationTtl: SEVEN_DAYS_SEC,
  });
  // Reverse index so the refund/dispute handler can find this token from
  // the original Stripe session id and delete it on revocation.
  await env.DOWNLOADS.put(`grant_session:${sessionId}`, token, {
    expirationTtl: SEVEN_DAYS_SEC,
  });
  return token;
}

interface CustomerPurchase {
  purchased_at: number;
  stripe_session_id: string;
  music_release_slugs: string[];
  digital_slugs?: string[];
  merch_items: Array<{ printful_variant_id?: number; quantity: number }>;
  amount_total: number;
  currency: string;
}

interface CustomerRecord {
  email: string;
  name?: string | null;
  first_seen_at: number;
  last_seen_at: number;
  purchases: CustomerPurchase[];
}

// Append a purchase to the customer record. Used by /library to show the
// buyer everything they've ever bought, regardless of email-link expiry.
async function recordCustomerPurchase(
  env: Env,
  email: string,
  name: string | null | undefined,
  session: Stripe.Checkout.Session,
  fulfillment: FulfillmentEntry[],
) {
  const lower = email.toLowerCase().trim();
  const key = `customer:${lower}`;
  const now = Math.floor(Date.now() / 1000);
  const existing = await env.DOWNLOADS.get(key);
  let record: CustomerRecord;
  if (existing) {
    try { record = JSON.parse(existing); } catch { record = {} as CustomerRecord; }
  } else {
    record = {
      email: lower,
      name: name || null,
      first_seen_at: now,
      last_seen_at: now,
      purchases: [],
    };
  }
  record.last_seen_at = now;
  if (name && !record.name) record.name = name;
  record.purchases = record.purchases || [];
  record.purchases.push({
    purchased_at: now,
    stripe_session_id: session.id,
    music_release_slugs: fulfillment
      .filter(f => f.type === 'music')
      .map(f => f.release_slug!)
      .filter(Boolean),
    digital_slugs: fulfillment
      .filter(f => f.type === 'digital')
      .map(f => f.digital_slug!)
      .filter(Boolean),
    merch_items: fulfillment
      .filter(f => f.type === 'merch')
      .map(f => ({ printful_variant_id: f.printful_variant_id, quantity: f.quantity })),
    amount_total: session.amount_total || 0,
    currency: session.currency || 'usd',
  });
  // No TTL — customer records persist permanently.
  await env.DOWNLOADS.put(key, JSON.stringify(record));

  // Reverse index by payment_intent so the refund/dispute handler — which
  // only receives the charge/payment_intent — can map back to the email +
  // session id without listing all customer records.
  const pi = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id;
  if (pi) {
    await env.DOWNLOADS.put(
      `pi:${pi}`,
      JSON.stringify({ email: lower, session_id: session.id }),
    );
  }
}

// Revoke access for a session that's been refunded or charged-back. Deletes
// the active download grant (so the email link stops working) and removes
// the matching purchase entry from the customer's record (so /library and
// the cookie-auth download path no longer treat it as owned).
async function revokeAccessForSession(env: Env, sessionId: string, email: string) {
  // Kill the active 7-day download grant if it still exists.
  const grantToken = await env.DOWNLOADS.get(`grant_session:${sessionId}`);
  if (grantToken) {
    await env.DOWNLOADS.delete(`grant:${grantToken}`);
    await env.DOWNLOADS.delete(`grant_session:${sessionId}`);
  }
  // Prune the matching purchase from the permanent customer record.
  const lower = email.toLowerCase().trim();
  const key = `customer:${lower}`;
  const raw = await env.DOWNLOADS.get(key);
  if (!raw) return;
  let record: CustomerRecord;
  try { record = JSON.parse(raw); } catch { return; }
  const before = (record.purchases || []).length;
  record.purchases = (record.purchases || []).filter(p => p.stripe_session_id !== sessionId);
  if (record.purchases.length !== before) {
    await env.DOWNLOADS.put(key, JSON.stringify(record));
  }
}

function releaseDateFor(slug: string): string {
  const r = (musicData as any).releases.find((x: any) => x.slug === slug);
  return r?.release_date || '';
}

function releaseTitleFor(slug: string): string {
  const r = (musicData as any).releases.find((x: any) => x.slug === slug);
  return r?.title || slug.toUpperCase().replace(/-/g, ' ');
}

// A pre-order gets its own email, with NO download button. The ordinary
// receipt cannot be reused with the link removed: its 7-day grant would have
// expired long before a release that is weeks out, so pointing a buyer at a
// link that is dead on arrival is worse than sending no link. The library is
// the durable route, and it unlocks itself at midnight ET on the date.
async function sendPreorderEmail(
  env: Env,
  to: string,
  items: Array<{ title: string; date: string }>,
) {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY missing — skipping email');
    return;
  }
  const configured = env.ORDER_FROM_EMAIL;
  const from = (!configured || configured.endsWith('@resend.dev'))
    ? 'orders@morphicsmusic.com'
    : configured;
  const titles = items.map(i => i.title).join(', ');
  const rows = items
    .map(i => `<li style="margin-bottom:6px">${i.title} — unlocks ${i.date || 'on release'}</li>`)
    .join('');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Morphics <${from}>`,
      to: [to],
      subject: `Pre-order confirmed · ${titles}`,
      html: `
        <div style="font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e8e8ec;padding:32px;max-width:560px;margin:auto">
          <h1 style="font-weight:700;letter-spacing:-0.02em">Pre-order confirmed.</h1>
          <p>Thanks for backing this before it is out. Nothing to download yet — the files appear in your library automatically on release day, and your access is permanent from then on.</p>
          <ul style="opacity:0.85;font-size:14px;padding-left:18px">${rows}</ul>
          <p style="margin:24px 0">
            <a href="https://morphicsmusic.com/library" style="background:#fff;color:#000;padding:14px 24px;text-decoration:none;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;font-size:11px">Your library</a>
          </p>
          <p style="opacity:0.7;font-size:13px;margin:24px 0">
            Sign in with this email address — no password needed.
          </p>
          <p style="opacity:0.4;font-size:11px;margin-top:32px">— Morphics</p>
        </div>`,
    }),
  });
  if (!res.ok) console.error('Resend failed:', await res.text());
}

async function sendDownloadEmail(env: Env, to: string, downloadUrl: string, releaseTitles: string[]) {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY missing — skipping email');
    return;
  }
  // onboarding@resend.dev is Resend's shared test sender: it only delivers to
  // the account owner, so real buyers never receive anything. morphicsmusic.com
  // is verified in Resend as of 2026-08-09, so ignore that value if it is still
  // configured rather than depending on someone remembering to clear it.
  const configured = env.ORDER_FROM_EMAIL;
  const from = (!configured || configured.endsWith('@resend.dev'))
    ? 'orders@morphicsmusic.com'
    : configured;
  const titles = releaseTitles.join(', ');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Morphics <${from}>`,
      to: [to],
      subject: `Your download · ${titles}`,
      html: `
        <div style="font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e8e8ec;padding:32px;max-width:560px;margin:auto">
          <h1 style="font-weight:700;letter-spacing:-0.02em">Thanks for supporting Morphics.</h1>
          <p>You now own this music — your access is permanent. Download from the link below right away, or sign in to your library any time to grab the files.</p>
          <p style="margin:24px 0">
            <a href="${downloadUrl}" style="background:#fff;color:#000;padding:14px 24px;text-decoration:none;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;font-size:11px">Download now</a>
          </p>
          <p style="opacity:0.7;font-size:13px;margin:24px 0">
            Lifetime access: <a href="https://morphicsmusic.com/library" style="color:#e8e8ec">morphicsmusic.com/library</a><br/>
            Sign in with this email address — no password needed.
          </p>
          <p style="opacity:0.5;font-size:12px">Releases: ${titles}</p>
          <p style="opacity:0.4;font-size:11px;margin-top:32px">The direct link above is valid for 7 days. After that, sign in to your library to keep downloading. — Morphics</p>
        </div>`,
    }),
  });
  if (!res.ok) console.error('Resend failed:', await res.text());
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const sig = request.headers.get('stripe-signature');
  if (!sig) return new Response('Missing signature', { status: 400 });

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-11-20.acacia' as any });
  const body = await request.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (e: any) {
    return new Response(`Bad signature: ${e.message}`, { status: 400 });
  }

  // Refund / dispute events revoke access. They share the same revocation
  // logic — full refund or chargeback both mean "the buyer no longer paid
  // for this", so pull the grant and the customer-record entry.
  const REVOKE_EVENTS = new Set([
    'charge.refunded',
    'charge.dispute.created',
    'charge.dispute.funds_withdrawn',
  ]);
  if (REVOKE_EVENTS.has(event.type)) {
    const charge = event.data.object as Stripe.Charge | Stripe.Dispute;
    const pi = typeof (charge as any).payment_intent === 'string'
      ? (charge as any).payment_intent
      : (charge as any).payment_intent?.id;
    if (!pi) return new Response('no payment_intent on event', { status: 200 });
    const completedKey = `webhook:completed:${event.id}`;
    if (await env.DOWNLOADS.get(completedKey)) return new Response('duplicate', { status: 200 });
    waitUntil((async () => {
      try {
        const raw = await env.DOWNLOADS.get(`pi:${pi}`);
        if (!raw) {
          // Webhook may have arrived before the original session.completed
          // wrote the index. Fall back to the Stripe API.
          const sessions = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 });
          const s = sessions.data[0];
          if (s?.id && s.customer_details?.email) {
            await revokeAccessForSession(env, s.id, s.customer_details.email);
          }
        } else {
          const { email, session_id } = JSON.parse(raw) as { email: string; session_id: string };
          await revokeAccessForSession(env, session_id, email);
        }
        await env.DOWNLOADS.put(completedKey, '1', { expirationTtl: 60 * 60 * 24 * 30 });
      } catch (e) {
        console.error('revocation error:', e);
        // Don't mark completed — Stripe will retry.
      }
    })());
    return new Response('revoking', { status: 200 });
  }

  if (event.type !== 'checkout.session.completed') {
    return new Response('ignored', { status: 200 });
  }

  // Two-stage idempotency: Stripe retries events on transient failures.
  // - "completed:<id>" is set ONLY after fulfillment succeeds — durable for
  //   30 days and short-circuits all subsequent retries.
  // - "in_progress:<id>" with a 5-min TTL guards against two near-simultaneous
  //   retries racing through fulfillment side-effects.
  // If a worker dies mid-flight, the in-progress key expires and Stripe
  // retries cleanly, vs. the previous design where setting "seen" upfront
  // would lock the customer into a no-fulfillment state forever.
  const completedKey = `webhook:completed:${event.id}`;
  const inProgressKey = `webhook:in_progress:${event.id}`;
  if (await env.DOWNLOADS.get(completedKey)) return new Response('duplicate', { status: 200 });
  if (await env.DOWNLOADS.get(inProgressKey)) return new Response('in progress', { status: 200 });
  await env.DOWNLOADS.put(inProgressKey, '1', { expirationTtl: 300 });

  const session = event.data.object as Stripe.Checkout.Session;

  // Read the full fulfillment plan from KV (written by checkout.ts under the
  // session.id key). This avoids Stripe's 500-char metadata truncation that
  // would otherwise drop items silently for larger carts.
  let fulfillment: FulfillmentEntry[] = [];
  try {
    const raw = await env.DOWNLOADS.get(`fulfillment:${session.id}`);
    if (raw) fulfillment = JSON.parse(raw);
  } catch {}
  if (fulfillment.length === 0) return new Response('no fulfillment data', { status: 200 });

  // Only re-fetch the session when we actually need shipping_details
  // (physical merch). Skip for digital-only orders to save a Stripe round-trip.
  const needsShipping = fulfillment.some(f => f.type === 'merch');
  const full = needsShipping
    ? await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['line_items', 'customer_details', 'shipping_details'],
      })
    : session;

  const merchItems = fulfillment.filter(f => f.type === 'merch');
  const musicItems = fulfillment.filter(f => f.type === 'music');
  const email = full.customer_details?.email;
  const name = full.customer_details?.name;

  // Run side-effects after responding so Stripe gets a 200 within its window.
  // On success → set completed key (30 days) so future retries short-circuit.
  // On failure → leave in_progress key to expire (5 min) so Stripe's next
  // retry attempt actually re-runs fulfillment cleanly.
  waitUntil((async () => {
    try {
      if (merchItems.length > 0) {
        await createPrintfulOrder(env, full, fulfillment);
      }
      if (email) {
        // Persist a permanent customer record so /library can show every
        // past order — separate from the 7-day download-grant tokens.
        await recordCustomerPurchase(env, email, name, full, fulfillment);
      }
      // One grant covers everything downloadable in the order, so a cart with
      // a release and a font produces a single email rather than two.
      //
      // Pre-ordered music is split off first. It is a purchase but not yet a
      // delivery, so it must not go into the grant: download.ts would refuse
      // it anyway, and including it would only put a title in a "download
      // now" email that cannot be downloaded.
      const digitalItems = fulfillment.filter(f => f.type === 'digital');
      const preorderItems = musicItems.filter(m => m.preorder);
      const readyMusic = musicItems.filter(m => !m.preorder);
      if ((readyMusic.length > 0 || digitalItems.length > 0) && email) {
        const slugs = readyMusic.map(m => m.release_slug!).filter(Boolean);
        const dslugs = digitalItems.map(d => d.digital_slug!).filter(Boolean);
        const token = await issueDownloadGrant(env, email, slugs, full.id, dslugs);
        const url = `${env.PUBLIC_SITE_URL || new URL(request.url).origin}/download?token=${token}`;
        const titles = [
          ...slugs.map(s => s.toUpperCase().replace(/-/g, ' ')),
          ...dslugs.map(d => digitalTitle(d)),
        ];
        await sendDownloadEmail(env, email, url, titles);
      }
      // A mixed cart therefore gets two emails, deliberately: one says
      // "download now" and is true, the other says "unlocks on the 14th" and
      // is also true. One email trying to say both is how a buyer misses the
      // half that applies to them.
      if (preorderItems.length > 0 && email) {
        await sendPreorderEmail(
          env,
          email,
          preorderItems
            .map(m => m.release_slug!)
            .filter(Boolean)
            .map(slug => ({ title: releaseTitleFor(slug), date: releaseDateFor(slug) })),
        );
      }
      await env.DOWNLOADS.put(completedKey, '1', { expirationTtl: 60 * 60 * 24 * 30 });
    } catch (e) {
      console.error('fulfillment error:', e);
      // Don't mark completed — Stripe will retry once the in_progress key expires.
    }
  })());

  return new Response('ok', { status: 200 });
};
