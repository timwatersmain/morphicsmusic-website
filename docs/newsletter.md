# Mailing list

Capture is live. Sending needs one 15-minute setup step (below).

## How it fits together

```
 signup form  ──POST /api/subscribe──┬─→ Cloudflare KV   "subscriber:<email>"   capture log
                                     └─→ Resend topic     opt_in                 send state
                                                │
 brain  ──GET /api/subscribers/export───────────┘  (merges both, token-gated)
        └─→ morphicsbrain.db  `subscribers`  +  `all_contacts` view
```

Two stores because they answer different questions, and **neither is a cache of
the other**:

- **KV** — who gave us an address, when, from which page. Ours, permanent, and
  what the brain syncs down. Survives ever leaving Resend.
- **Resend** — whether they still want mail. It must live there because that is
  where the unsubscribe link in every newsletter points; a status kept anywhere
  else is wrong the moment someone clicks it.

KV is never consulted to decide whether to send. Resend is never consulted for
where someone came from.

## Remaining setup

1. Create the topic and get its id:
   ```
   RESEND_API_KEY=re_xxx node scripts/setup-newsletter-topic.mjs
   ```
2. Install the id and redeploy (Pages only binds a secret at build time):
   ```
   echo '<id>' | npx wrangler pages secret put RESEND_TOPIC_ID --project-name=morphicsmusic-website
   git commit --allow-empty -m "chore: redeploy for RESEND_TOPIC_ID" && git push origin main
   ```
3. If anyone signed up before this, push them to Resend:
   ```
   RESEND_API_KEY=re_xxx SUBSCRIBERS_EXPORT_TOKEN=... node scripts/setup-newsletter-topic.mjs --backfill
   ```

Until step 2 lands, signups are still **captured** — they just are not
registered with the sending provider, and the export marks them
`in_resend: false` so the gap is visible instead of silent.

## Sending the monthly newsletter

In Resend → Broadcasts. Write it, send it to the **Monthly Dispatch** topic.
Unsubscribe links, one-click headers and bounce handling are Resend's.

**You must put a postal address in the broadcast footer.** CAN-SPAM requires a
valid physical mailing address in every commercial email; a PO box is fine.
This is the one piece of the newsletter no code can supply.

## Syncing contacts into the brain

```
source ~/.morphics-newsletter.env
node ~/Desktop/MorphicsBrain/scripts/sync-subscribers.mjs [--dry-run]
```

Writes only when something changed, and follows the safe-write procedure for
this database (stop `com.morphics.resolve-bridge`, back up, one IMMEDIATE
transaction, integrity check, restart) — bare writes alongside the bridge are
what corrupted it in May. The bridge is restarted on every exit path including
a crash.

It never deletes. A subscriber missing from an export has not asked to be
forgotten — far likelier the fetch was partial — and silently dropping rows on
a bad fetch is unrecoverable.

Query `subscribers` for fans, `contacts` for booking outreach, `all_contacts`
for everyone.

## Limits worth knowing

Resend free: **3,000 emails/month, 100/day**, 1,000 marketing contacts. The
100/day cap is the real ceiling — a monthly send to 400 people takes four days
on free. Marketing paid starts at $40/mo. Transactional mail (order receipts,
verification) shares the same monthly allowance.

## Deliberate decisions

- **Single opt-in.** A confirmation round trip loses a large share of real
  signups on a small, low-risk list. What it opens up — signing somebody else
  up — is bounded by the rate limit, a honeypot, and a welcome email carrying
  the unsubscribe link. That link is *why* single opt-in is defensible; do not
  remove it.
- **Unsubscribe never expires and needs no session.** It is clicked months
  later, on another device, often by someone with no account. A dead
  unsubscribe link becomes a spam complaint, which costs far more than a link
  that stays valid. It is signed so `?e=` cannot be edited to remove someone
  else.
- **Opt-out keeps a tombstone** rather than deleting the row. Only a tombstone
  stops a later import silently re-adding someone who said no.
- **Existing buyers were not imported.** Buying a record is not asking for
  marketing, and a list of people who never opted in generates the complaints
  that get a sending domain flagged.
