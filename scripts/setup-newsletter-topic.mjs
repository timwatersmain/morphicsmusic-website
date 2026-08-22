#!/usr/bin/env node
/**
 * setup-newsletter-topic.mjs — one-time: create the Resend topic the mailing
 * list subscribes people to, and print the id to install as a Pages secret.
 *
 *   RESEND_API_KEY=re_xxx node scripts/setup-newsletter-topic.mjs
 *
 * Run once. Until RESEND_TOPIC_ID is set, /api/subscribe still captures every
 * address into KV — it just cannot register them with the sending provider, and
 * the export marks those rows in_resend:false so the gap is visible rather than
 * silent. Nobody is lost in the meantime; they need re-pushing to Resend, which
 * `--backfill` does.
 *
 * defaultSubscription is opt_in and CANNOT BE CHANGED LATER. That is correct
 * here: everyone in this topic asked for it through the form. A topic created
 * as opt_out would treat every contact as subscribed by default, which is the
 * opposite of what the signup means.
 */

const KEY = process.env.RESEND_API_KEY;
const BACKFILL = process.argv.includes('--backfill');

if (!KEY) {
  console.error('RESEND_API_KEY is not set.\n\nGet it from https://resend.com/api-keys, then:\n  RESEND_API_KEY=re_xxx node scripts/setup-newsletter-topic.mjs');
  process.exit(1);
}

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.resend.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status} ${JSON.stringify(body)}`);
  return body;
};

const NAME = 'Monthly Dispatch';

async function main() {
  // Idempotent: re-running must not create a second topic with the same name,
  // because two topics means half the list is subscribed to the one you are
  // not sending to.
  const existing = await api('/topics').catch(() => ({ data: [] }));
  let topic = (existing.data || []).find(t => t.name === NAME);

  if (topic) {
    console.log(`Topic "${NAME}" already exists.`);
  } else {
    topic = await api('/topics', {
      method: 'POST',
      body: JSON.stringify({
        name: NAME,
        defaultSubscription: 'opt_in',
        description: 'Monthly newsletter: releases, work in progress, and shows.',
      }),
    });
    console.log(`Created topic "${NAME}".`);
  }

  console.log(`\n  RESEND_TOPIC_ID = ${topic.id}\n`);
  console.log('Install it with:');
  console.log(`  echo '${topic.id}' | npx wrangler pages secret put RESEND_TOPIC_ID --project-name=morphicsmusic-website`);
  console.log('\nThen REDEPLOY — Pages only binds a new secret into a deployment at build time,');
  console.log('so until main is pushed again the endpoint cannot see it.');

  if (BACKFILL) {
    const token = process.env.SUBSCRIBERS_EXPORT_TOKEN;
    const site = process.env.MORPHICS_SITE_URL || 'https://morphicsmusic.com';
    if (!token) {
      console.error('\n--backfill needs SUBSCRIBERS_EXPORT_TOKEN (see ~/.morphics-newsletter.env)');
      process.exit(1);
    }
    const res = await fetch(`${site}/api/subscribers/export`, { headers: { 'X-Export-Token': token } });
    if (!res.ok) throw new Error(`export → ${res.status}`);
    const { subscribers = [] } = await res.json();
    const missing = subscribers.filter(s => !s.in_resend && !s.unsubscribed);
    console.log(`\nBackfilling ${missing.length} subscriber(s) captured before Resend was configured…`);
    for (const s of missing) {
      try {
        await api('/contacts', {
          method: 'POST',
          body: JSON.stringify({ email: s.email, topics: [{ id: topic.id, subscription: 'opt_in' }] }),
        });
        console.log(`  ok   ${s.email}`);
      } catch (e) {
        console.log(`  FAIL ${s.email} — ${e.message}`);
      }
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
