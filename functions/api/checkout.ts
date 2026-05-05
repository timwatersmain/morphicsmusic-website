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
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
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

  for (const item of body.items) {
    if (item.qty <= 0 || item.qty > 10) return new Response('Bad qty', { status: 400 });

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

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: 'payment',
    line_items: lineItems,
    success_url: `${origin}/order-complete?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/store`,
    payment_method_types: ['card'],
    automatic_tax: { enabled: false },
    metadata: {
      // Stripe metadata values are strings ≤500 chars. Keep fulfillment compact.
      fulfillment: JSON.stringify(fulfillment).slice(0, 500),
    },
    payment_intent_data: {
      metadata: { fulfillment: JSON.stringify(fulfillment).slice(0, 500) },
    },
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
    return new Response(JSON.stringify({ url: session.url }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(`Stripe error: ${e.message}`, { status: 500 });
  }
};
