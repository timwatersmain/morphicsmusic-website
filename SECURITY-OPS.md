# Security Ops — what's done and what's left

Last updated 2026-05-09.

## ✅ Done autonomously this session

- **R2 public access disabled.** The `morphicsbrain-media` bucket's
  `pub-a0375585d55c403e96807f495afed472.r2.dev` URL was leaking the
  entire `masters/` prefix. Curl confirmed unauthenticated download of
  `masters/distort/Distort.mp3` (200 with full audio). Bucket is now
  private — `r2.dev` returns 401.
- **Social videos rerouted through a Pages proxy.** `signal.json`'s
  6 `pub-…r2.dev/<file>.mp4` URLs now point at
  `/api/social-media/<file>.mp4`. The new `functions/api/social-media/[key].ts`
  proxies the bucket via the Pages function with a strict allow-list
  regex (`^[A-Za-z0-9_-]+\.(mp4|mov|webm|jpg|jpeg|png)$`) — anything
  with a slash (i.e. `masters/...`) is rejected. Range requests are
  honoured so `<video>` seeking still works.
- **Sync script updated** so the URL rewrite survives every prebuild
  regeneration of `signal.json`.
- **CSP tightened** further — `*.r2.dev` removed from img-src and
  media-src now that the bucket is private.
- **Bot challenge confirmed active** on `/api/*` at the zone level —
  curl/script clients without browser fingerprints get
  `cf-mitigated: challenge`. Real browsers pass through invisibly.
  Effectively covers the "WAF managed rules on /api/*" audit ask.

## Still need YOU to do these

These can't be automated — they need either dashboard clicks or a key
that doesn't live in the repo.

### 1. Repopulate `merch.json` variants — 30 seconds (one command)

Until this runs, beanie checkout 400s. Get your Printful API key from
your Printful account settings (or copy the existing
`PRINTFUL_API_KEY` value out of Cloudflare Pages → Settings → Env
vars), then:

```bash
cd ~/Desktop/MorphicsBrain/website
PRINTFUL_API_KEY=pf_xxxxx npm run sync:printful
git add src/data/merch.json
git commit -m "Resync merch.json — restore variants[]"
git push origin main
```

### 2. Create Turnstile site — 90 seconds in dashboard, then I set the keys

Code is wired. Until you create the widget the form still works,
just without bot protection.

1. Open <https://dash.cloudflare.com/?to=/:account/turnstile> → click **Add site**
2. Site name: `morphicsmusic-login`
3. Domains: add three lines
   - `morphicsmusic.com`
   - `www.morphicsmusic.com`
   - `morphicsmusic-website.pages.dev`
4. Widget Mode: **Managed** (default)
5. Click **Create**
6. Copy the **Site Key** and **Secret Key** that appear

Paste them back to me and I'll run:
```bash
echo "<site-key>" | npx wrangler pages secret put PUBLIC_TURNSTILE_SITE_KEY --project-name=morphicsmusic-website
echo "<secret>"   | npx wrangler pages secret put TURNSTILE_SECRET_KEY    --project-name=morphicsmusic-website
```
…then push an empty commit to trigger a redeploy with the new env vars active.

### 3. Stripe test keys for preview env — 60 seconds

Right now any Cloudflare Pages preview URL (every PR / branch deploy)
uses your **live** Stripe keys, **live** Printful API key, and the same
KV namespace as production. A preview can mint real checkout sessions.

Two paths:

**Path A (recommended, free):** add Stripe test keys to the Preview env
- <https://dashboard.stripe.com/test/apikeys> → copy `Publishable key` (pk_test_…) and `Secret key` (sk_test_…)
- <https://dashboard.stripe.com/test/webhooks> → "Add endpoint" → URL `https://morphicsmusic-website.pages.dev/api/stripe-webhook` → events `checkout.session.completed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.funds_withdrawn` → copy the signing secret (whsec_…)

Paste the three values back to me; I'll run:
```bash
echo "sk_test_..."   | npx wrangler pages secret put STRIPE_SECRET_KEY    --project-name=morphicsmusic-website --branch=preview
echo "whsec_..."     | npx wrangler pages secret put STRIPE_WEBHOOK_SECRET --project-name=morphicsmusic-website --branch=preview
echo "<random-32B>"  | npx wrangler pages secret put AUTH_SECRET           --project-name=morphicsmusic-website --branch=preview
```
(`AUTH_SECRET` for preview must be different from prod so a preview cookie never validates against prod sessions.)

**Path B (simplest, no Stripe needed):** gate previews behind Cloudflare Access
- <https://dash.cloudflare.com/?to=/:account/access/apps> → **Add an application** → **Self-hosted**
- Name: `Morphics preview`
- Application domain: `*.morphicsmusic-website.pages.dev`
- Add a policy: "Allow" + email matches `you@morphicsmusic.com`
- Click **Save**

Done — previews now require you to log in with Cloudflare Access. Real
customers can never reach a preview URL even if it leaks.

### 4. (Optional) Bigger WAF rule beyond what's already on

Bot challenge is already firing on `/api/*` per zone settings — that
covers the audit's main ask. If you want a paid Pro/Business plan
managed-rule deployment:
- <https://dash.cloudflare.com/?to=/:account/:zone/security/waf>
- Managed rules → enable **Cloudflare Managed Ruleset** at sensitivity
  Medium, Action: Block.

Free plan can't run that ruleset; the existing bot challenge is the
free-tier equivalent.

---

## Reference: what's *fully* shipped on the code side

You don't need to touch any of these — they're live.

### Critical / High audit items

- **Stripe webhook** handles `charge.refunded`, `charge.dispute.created`,
  `charge.dispute.funds_withdrawn`. Refunds and chargebacks revoke the
  download grant + prune the customer record by `stripe_session_id`.
- **`/api/download` path validation** — the requested key must match an
  exact entry in `masters-manifest.json`. Path-traversal (`..`, `.`,
  empty, `\`, NUL) rejected before R2 is touched.
- **Use-counter race** mitigated — increment moved before streaming;
  60s debounce so link-preview bots can't burn quota.
- **R2 bucket** locked down (this session) — see "Done" above.
- **Dynamic CORS** with `Vary: Origin` allow-listed to
  `morphicsmusic.com` + `www.morphicsmusic.com`.

### Auth / session

- Cookie renamed to `__Host-morphics_auth` (browser-enforced host pin).
- TTL dropped 365 → 30 days.
- Per-user `ver` field — `/api/auth/logout` bumps `session_ver:<email>`
  in KV, invalidating every outstanding cookie immediately.
- `verify.ts` re-validates `grant.redirect` and sets
  `Referrer-Policy: no-referrer` on the 303.
- Login email now fire-and-forget via `waitUntil` with 5s
  `AbortSignal.timeout` — closes a timing oracle.
- Turnstile gate on `/login` (no-op until you finish step 2 above).

### Headers / CSP

- `img-src` pinned to known hosts (was `https:` open).
- `*.tiktokcdn.com` dropped from `frame-src` (unused).
- `upgrade-insecure-requests` added.
- Inline `onclick=` removed from cart triggers.

### Library / data leakage

- `/api/library` strips `stripe_session_id` and `merch_items` from
  client responses.

---

## Deferred — bigger refactors, separate pass

- **Drop `script-src 'unsafe-inline'`.** Astro emits inline
  `<script type="module">` for `ParticleBackground.astro` and
  `TopNav.astro`'s account-link probe. Externalising them needs Vite/
  Astro config work.
- **Rate-limit binding.** Cloudflare Pages does not support the native
  Rate Limiting binding (Workers-only); upgrading would require a full
  Pages → Workers + Static Assets migration. Keep the KV-based per-
  endpoint limiter (`functions/_lib/ratelimit.ts`) until that migration
  is in scope.

---

## 2026-05-10 — Per-endpoint rate limits

- Shared library `functions/_lib/ratelimit.ts` returns
  `{ ok, retryAfter, remaining }` and ships matching `429 + Retry-After`
  helpers (JSON for clients, plain text for binary endpoints).
- All `/api/*` endpoints have explicit limits (per IP unless noted):
  - `login` 5/10min + 3/hr per email (silent-200 on hit, no enumeration)
  - `verify` 30/min (redirects to `/login?expired=1` on hit)
  - `me` 120/min, `library` 60/min, `download` 60/min,
    `social-media/[key]` 120/min, `checkout` 20/10min
  - `stripe-webhook` and `logout` deliberately unlimited
- The dashboard `api-throttle` Block rule that previously IP-banned the
  whole site for any `/api/*` burst was retired/demoted on 2026-05-10
  because it produced "owner has banned you" pages for legitimate users
  (NAT'd, multi-tab, or sharing IPs). App-layer 429s are now the primary
  defense; if a backstop is desired, recreate the rule with action set
  to **Managed Challenge** rather than Block.
