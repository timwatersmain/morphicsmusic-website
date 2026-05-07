// POST /api/checkout
// Body: { items: CartItem[] }
// Returns: { url } — Stripe-hosted checkout URL
//
// We construct line_items on the server (never trust client prices for fixed-
// price merch). Music items use a name-your-price model where the client price
// is accepted as long as it meets the catalog minimum.

import Stripe from 'stripe';
import merchData from '../../src/data/merch.json';
import musicData from '../../src/data/music-catalog.json';

interface CartItem {
  type: 'merch' | 'music';
  sku: string;
  title: string;
  subtitle?: string;
  image?: string;
  qty: number;
  unit_amount: number;
  metadata: {
    printful_variant_id?: number;
    sku?: string;
    release_slug?: string;
  };
}

interface Env {
  STRIPE_SECRET_KEY: string;
  PUBLIC_SITE_URL?: string;
  DOWNLOADS: KVNamespace;
}

async function checkRateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<boolean> {
  const raw = await env.DOWNLOADS.get(`rl:${key}`);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= limit) return false;
  await env.DOWNLOADS.put(`rl:${key}`, String(count + 1), { expirationTtl: windowSec });
  return true;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // Rate limit: 20 sessions per IP per 10 min. Genuine cart usage is well
  // below this; spammers hit it instantly.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ok = await checkRateLimit(env, `checkout:ip:${ip}`, 20, 600);
  if (!ok) return new Response('Too many checkout attempts', { status: 429 });

  let body: { items: CartItem[] };
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  if (!body?.items?.length) return new Response('Empty cart', { status: 400 });

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-11-20.acacia' as any });

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  const fulfillment: any[] = []; // recorded in metadata for the webhook
  let hasPhysical = false;
  let hasDigital = false;

  // Sanity ceiling on cart size — prevents creating absurdly large Stripe
  // sessions that would just be rejected anyway.
  if (body.items.length > 50) return new Response('Cart too large', { status: 400 });

  for (const item of body.items) {
    if (!Number.isInteger(item.qty) || item.qty <= 0 || item.qty > 10) {
      return new Response('Bad qty', { status: 400 });
    }
    if (!Number.isInteger(item.unit_amount) || item.unit_amount < 0 || item.unit_amount > 100000) {
      // $1000 cap. Anything legitimate is well below this.
      return new Response('Bad amount', { status: 400 });
    }

    if (item.type === 'merch') {
      const product = (merchData as any[]).find(p => p.slug === item.sku.split(':')[1]);
      if (!product) return new Response(`Unknown merch ${item.sku}`, { status: 400 });
      const variant = product.variants.find((v: any) => v.variant_id === item.metadata.printful_variant_id);
      if (!variant || !variant.available) return new Response(`Unavailable ${item.sku}`, { status: 400 });

      hasPhysical = true;
      const cents = Math.round(variant.retail_price * 100);
      lineItems.push({
        quantity: item.qty,
        price_data: {
          currency: 'usd',
          unit_amount: cents,
          product_data: {
            name: product.name,
            description: [variant.size, variant.color].filter(Boolean).join(' · ') || undefined,
            images: product.thumbnail ? [product.thumbnail] : undefined,
            metadata: { printful_variant_id: String(variant.variant_id), sku: variant.sku || '' },
          },
        },
      });
      fulfillment.push({
        type: 'merch',
        printful_variant_id: variant.variant_id,
        quantity: item.qty,
        retail_price: variant.retail_price,
      });
    } else if (item.type === 'music') {
      const release = (musicData as any).releases.find((r: any) => r.slug === item.metadata.release_slug);
      if (!release) return new Response(`Unknown release ${item.sku}`, { status: 400 });
      if (item.unit_amount < release.min_price_cents) {
        return new Response(`Below minimum for ${release.slug}`, { status: 400 });
      }

      hasDigital = true;
      lineItems.push({
        quantity: item.qty,
        price_data: {
          currency: 'usd',
          unit_amount: item.unit_amount,
          product_data: {
            name: `${release.title} (digital)`,
            description: `${release.type.toUpperCase()} · ${release.track_count} track${release.track_count === 1 ? '' : 's'}`,
            images: release.artwork?.startsWith('http') ? [release.artwork] : undefined,
            metadata: { release_slug: release.slug, kind: 'digital' },
          },
        },
      });
      fulfillment.push({ type: 'music', release_slug: release.slug, quantity: item.qty });
    } else {
      return new Response(`Unknown item type`, { status: 400 });
    }
  }

  const origin = env.PUBLIC_SITE_URL || new URL(request.url).origin;

  // Compact summary that's safe to put in Stripe metadata (≤500 char limit).
  // Webhook reads the full fulfillment from KV by session_id below; this is
  // just a human-readable hint for the Stripe dashboard.
  const summary = fulfillment
    .map(f => f.type === 'music' ? `music:${f.release_slug}x${f.quantity}` : `merch:${f.printful_variant_id}x${f.quantity}`)
    .join(',')
    .slice(0, 480);

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: 'payment',
    line_items: lineItems,
    success_url: `${origin}/order-complete?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/store`,
    payment_method_types: ['card'],
    automatic_tax: { enabled: false },
    metadata: { summary },
    payment_intent_data: { metadata: { summary } },
  };

  if (hasPhysical) {
    params.shipping_address_collection = { allowed_countries: ['US'] };
    params.shipping_options = [
      {
        shipping_rate_data: {
          display_name: 'Standard shipping (US)',
          type: 'fixed_amount',
          fixed_amount: { amount: 500, currency: 'usd' },
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 5 },
            maximum: { unit: 'business_day', value: 10 },
          },
        },
      },
    ];
  }
  if (hasDigital) {
    params.customer_creation = 'always';
    params.phone_number_collection = { enabled: false };
  }

  try {
    const session = await stripe.checkout.sessions.create(params);
    // Store the full fulfillment plan in KV keyed by session.id. The webhook
    // reads it on checkout.session.completed. KV has no 500-char ceiling, so
    // this avoids the silent truncation bug that would let large carts pay
    // successfully but receive nothing.
    await env.DOWNLOADS.put(
      `fulfillment:${session.id}`,
      JSON.stringify(fulfillment),
      { expirationTtl: 60 * 60 * 24 * 7 }, // 7 days — covers webhook retries
    );
    return new Response(JSON.stringify({ url: session.url }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(`Stripe error: ${e.message}`, { status: 500 });
  }
};
