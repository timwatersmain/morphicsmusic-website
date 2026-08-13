// GET /api/order?session_id=cs_...
//
// Exchanges a *paid* Stripe checkout session for a download grant, so the
// thank-you page can hand the buyer their files immediately instead of making
// them wait on an email. Email stays as the backup route, not the only one.
//
// Trust comes from Stripe, not from the URL: the session id is unguessable,
// and we ask Stripe whether it was actually paid before granting anything.

import Stripe from 'stripe';
import digitalData from '../../src/data/digital.json';
import catalog from '../../src/data/music-catalog.json';
import manifest from '../../src/data/masters-manifest.json';
import { corsHandler, preflight } from '../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../_lib/ratelimit';

interface Env {
  STRIPE_SECRET_KEY: string;
  DOWNLOADS: KVNamespace;
}

const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;

function tokenHex(bytes = 24) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

export const onRequestGet: PagesFunction<Env> = corsHandler<Env>(async ({ request, env }) => {
  const rl = await rateLimit(env, 'order', 'ip', clientIp(request), 30, 600);
  if (!rl.ok) return rateLimitedJson(rl);

  const sessionId = new URL(request.url).searchParams.get('session_id') || '';
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    return Response.json({ error: 'bad session' }, { status: 400 });
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-11-20.acacia' as any });

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch {
    return Response.json({ error: 'unknown session' }, { status: 404 });
  }
  if (session.payment_status !== 'paid') {
    return Response.json({ paid: false }, { status: 200 });
  }

  // The plan written by checkout.ts when the session was created.
  let fulfillment: any[] = [];
  try {
    const raw = await env.DOWNLOADS.get(`fulfillment:${sessionId}`);
    if (raw) fulfillment = JSON.parse(raw);
  } catch { /* fall through to an empty list */ }

  const releaseSlugs = fulfillment.filter(f => f.type === 'music')
    .map(f => f.release_slug).filter(Boolean);
  const digitalSlugs = fulfillment.filter(f => f.type === 'digital')
    .map(f => f.digital_slug).filter(Boolean);

  if (releaseSlugs.length === 0 && digitalSlugs.length === 0) {
    return Response.json({ paid: true, items: [] });
  }

  // Reuse the grant token this session already has, if the webhook got here
  // first — otherwise mint one. Either way the buyer ends up with one token.
  let token = await env.DOWNLOADS.get(`grant_session:${sessionId}`);
  if (!token) {
    token = tokenHex();
    const now = Math.floor(Date.now() / 1000);
    await env.DOWNLOADS.put(`grant:${token}`, JSON.stringify({
      email: session.customer_details?.email || '',
      release_slugs: releaseSlugs,
      digital_slugs: digitalSlugs,
      created_at: now,
      expires_at: now + SEVEN_DAYS_SEC,
      uses: 0,
    }), { expirationTtl: SEVEN_DAYS_SEC });
    await env.DOWNLOADS.put(`grant_session:${sessionId}`, token, {
      expirationTtl: SEVEN_DAYS_SEC,
    });
  }

  const items = [
    ...digitalSlugs.map((slug: string) => {
      const p = (digitalData as any[]).find(d => d.slug === slug);
      return p && {
        kind: 'digital',
        title: p.name,
        files: [{ key: p.file.r2_key, filename: p.file.filename }],
      };
    }).filter(Boolean),
    ...releaseSlugs.map((slug: string) => {
      const r = (catalog as any).releases.find((x: any) => x.slug === slug);
      return r && {
        kind: 'music',
        title: r.title,
        files: ((manifest as any).releases?.[slug] || []),
      };
    }).filter(Boolean),
  ];

  return Response.json({ paid: true, token, items });
});
