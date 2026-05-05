// POST /api/stripe-webhook
// Verifies Stripe signature, then on checkout.session.completed:
//  - creates a Printful order for any physical line items
//  - issues a download token for any digital music line items
//  - emails the buyer their download link via Resend
//
// Stripe → set this URL in Dashboard → Developers → Webhooks. Listen for:
//   checkout.session.completed
// Copy the signing secret into env STRIPE_WEBHOOK_SECRET.

import Stripe from 'stripe';

interface FulfillmentEntry {
  type: 'merch' | 'music';
  printful_variant_id?: number;
  quantity: number;
  retail_price?: number;
  release_slug?: string;
}

interface DownloadGrant {
  email: string;
  release_slugs: string[];
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

async function issueDownloadGrant(env: Env, email: string, releaseSlugs: string[]) {
  const token = tokenHex();
  const now = Math.floor(Date.now() / 1000);
  const grant: DownloadGrant = {
    email,
    release_slugs: releaseSlugs,
    created_at: now,
    expires_at: now + SEVEN_DAYS_SEC,
    uses: 0,
  };
  await env.DOWNLOADS.put(`grant:${token}`, JSON.stringify(grant), {
    expirationTtl: SEVEN_DAYS_SEC,
  });
  return token;
}

async function sendDownloadEmail(env: Env, to: string, downloadUrl: string, releaseTitles: string[]) {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY missing — skipping email');
    return;
  }
  const from = env.ORDER_FROM_EMAIL || 'orders@morphicsmusic.com';
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
          <p>Your download is ready. The link is good for 7 days and 5 downloads.</p>
          <p style="margin:24px 0">
            <a href="${downloadUrl}" style="background:#fff;color:#000;padding:14px 24px;text-decoration:none;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;font-size:11px">Download</a>
          </p>
          <p style="opacity:0.5;font-size:12px">Releases: ${titles}</p>
          <p style="opacity:0.4;font-size:11px;margin-top:32px">If the link expires, reply to this email and I'll send a fresh one. — Morphics</p>
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

  if (event.type !== 'checkout.session.completed') {
    return new Response('ignored', { status: 200 });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  // Re-fetch with shipping_details expanded — present on completed sessions.
  const full = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ['line_items', 'customer_details', 'shipping_details'],
  });

  let fulfillment: FulfillmentEntry[] = [];
  try {
    fulfillment = JSON.parse(full.metadata?.fulfillment || '[]');
  } catch {}
  if (fulfillment.length === 0) return new Response('no fulfillment data', { status: 200 });

  const merchItems = fulfillment.filter(f => f.type === 'merch');
  const musicItems = fulfillment.filter(f => f.type === 'music');
  const email = full.customer_details?.email;

  // Run side-effects after responding so Stripe gets a 200 within its window.
  waitUntil((async () => {
    try {
      if (merchItems.length > 0) {
        await createPrintfulOrder(env, full, fulfillment);
      }
      if (musicItems.length > 0 && email) {
        const slugs = musicItems.map(m => m.release_slug!).filter(Boolean);
        const token = await issueDownloadGrant(env, email, slugs);
        const url = `${env.PUBLIC_SITE_URL || new URL(request.url).origin}/download?token=${token}`;
        await sendDownloadEmail(env, email, url, slugs.map(s => s.toUpperCase().replace(/-/g, ' ')));
      }
    } catch (e) {
      console.error('fulfillment error:', e);
    }
  })());

  return new Response('ok', { status: 200 });
};
