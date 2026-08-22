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
import digitalData from '../../src/data/digital.json';
import { isReleased } from '../_lib/release-gate.mjs';
import { isPreorderable, isDigitalPreorderable, digitalSellable } from '../_lib/preorder.mjs';
import { corsHandler, preflight } from '../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../_lib/ratelimit';

interface CartItem {
  type: 'merch' | 'music' | 'digital';
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
    digital_slug?: string;
  };
}

interface Env {
  STRIPE_SECRET_KEY: string;
  PUBLIC_SITE_URL?: string;
  DOWNLOADS: KVNamespace;
}

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

export const onRequestPost: PagesFunction<Env> = corsHandler<Env>(async ({ request, env }) => {
  // 20 sessions per IP per 10 min. Genuine cart usage is well below this;
  // spammers hit it instantly.
  const rl = await rateLimit(env, 'checkout', 'ip', clientIp(request), 20, 600);
  if (!rl.ok) return rateLimitedJson(rl);

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
      // Two ways to be sellable: it is out, or it is an opted-in pre-order.
      // Anything else is still refused here — this gate is the ONLY thing
      // that decides what may be bought, so the client cannot talk its way
      // past it by putting an unreleased slug in the cart by hand.
      const preorder = isPreorderable(release.slug, release.release_date);
      if (!preorder && !isReleased(release.release_date)) {
        return new Response(`Not yet released: ${release.slug}`, { status: 403 });
      }

      hasDigital = true;
      lineItems.push({
        quantity: item.qty,
        price_data: {
          currency: 'usd',
          unit_amount: item.unit_amount,
          // The buyer is about to be handed to Stripe's checkout page, and it
          // is the last screen before their card is charged. If what they are
          // buying will not arrive today, it has to say so THERE, not only on
          // our own page — a pre-order that reads as an ordinary purchase at
          // the moment of payment is how chargebacks start.
          product_data: {
            name: preorder ? `${release.title} (digital pre-order)` : `${release.title} (digital)`,
            description: preorder
              ? `${release.type.toUpperCase()} · ${release.track_count} track${release.track_count === 1 ? '' : 's'} · unlocks ${release.release_date}`
              : `${release.type.toUpperCase()} · ${release.track_count} track${release.track_count === 1 ? '' : 's'}`,
            images: release.artwork?.startsWith('http') ? [release.artwork] : undefined,
            metadata: { release_slug: release.slug, kind: 'digital', preorder: preorder ? '1' : '0' },
          },
        },
      });
      fulfillment.push({ type: 'music', release_slug: release.slug, quantity: item.qty, preorder });
    } else if (item.type === 'digital') {
      // Fixed-price downloads (fonts, packs, plugins). Unlike music these are
      // not name-your-price — the price comes from the catalogue, never from
      // the client. A `release_date` on the product is optional: without one
      // it ships on purchase, as fonts and packs always have; with one it can
      // be pre-ordered and is held until that date.
      const product = (digitalData as any[]).find(p => p.slug === item.metadata.digital_slug);
      if (!product) return new Response(`Unknown digital ${item.sku}`, { status: 400 });
      const dPreorder = isDigitalPreorderable(product.slug, product.release_date);
      if (!digitalSellable(product)) return new Response(`Unavailable ${item.sku}`, { status: 400 });
      // Stripe cannot take a zero-amount payment — a $0 line item is an API
      // error, not a free order — so a free product has no path through here
      // at all. Refuse it explicitly with a message that names the right
      // door, rather than letting it fail as an opaque Stripe error.
      if (product.price_cents === 0) {
        return new Response(`${item.sku} is free — claim it at /api/claim`, { status: 400 });
      }

      hasDigital = true;
      lineItems.push({
        quantity: 1, // one licence per order; quantity is meaningless here
        price_data: {
          currency: 'usd',
          unit_amount: product.price_cents,
          product_data: {
            name: dPreorder ? `${product.name} (pre-order)` : product.name,
            description: dPreorder
              ? `${product.tagline} · unlocks ${product.release_date}`
              : product.tagline,
            images: product.thumbnail?.startsWith('http') ? [product.thumbnail] : undefined,
            metadata: { digital_slug: product.slug, kind: 'digital', preorder: dPreorder ? '1' : '0' },
          },
        },
      });
      fulfillment.push({ type: 'digital', digital_slug: product.slug, quantity: 1, preorder: dPreorder });
    } else {
      return new Response(`Unknown item type`, { status: 400 });
    }
  }

  const origin = env.PUBLIC_SITE_URL || new URL(request.url).origin;

  // Compact summary that's safe to put in Stripe metadata (≤500 char limit).
  // Webhook reads the full fulfillment from KV by session_id below; this is
  // just a human-readable hint for the Stripe dashboard.
  const summary = fulfillment
    .map(f => {
      if (f.type === 'music') return `${f.preorder ? 'preorder' : 'music'}:${f.release_slug}x${f.quantity}`;
      if (f.type === 'digital') return `${f.preorder ? 'preorder' : 'digital'}:${f.digital_slug}`;
      return `merch:${f.printful_variant_id}x${f.quantity}`;
    })
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
});
