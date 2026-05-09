# Security Ops Checklist

Code-level security work landed in commits `44de862` and `e39da52` plus the
Turnstile integration after that. The remaining items below all live in the
Cloudflare Pages dashboard or require running a one-shot script with a key
that doesn't live in this repo.

Do these in any order — none depend on each other.

---

## 1. Repopulate `merch.json` variants

The `variants[]` array in `src/data/merch.json` got dropped at some point;
checkout for any merch item currently 400s because the variant lookup
returns `undefined`. Fix is one command:

```bash
# requires PRINTFUL_API_KEY — same value already set in Cloudflare Pages env
PRINTFUL_API_KEY=pf_xxx npm run sync:printful
git add src/data/merch.json
git commit -m "Resync merch.json — restores variants[]"
git push origin main
```

`scripts/sync-printful.mjs` calls Printful's API and writes the full
product + variant catalog. Until this runs, the Morphorm plugin teaser
on `/store` is the only sellable surface.

---

## 2. Enable Turnstile on `/login`

Code is wired (`src/pages/login.astro` + `functions/api/auth/login.ts`).
Until the env vars are set the widget is a no-op and the server treats
the challenge as disabled.

1. Cloudflare dashboard → **Turnstile** → **Add site**
   - Domain: `morphicsmusic.com`, also `www.morphicsmusic.com`
   - Widget Mode: **Managed** (default — invisible challenge unless suspicious)
2. Copy the **Site Key** and **Secret Key**
3. Cloudflare Pages → **morphicsmusic-website** → **Settings → Environment variables**
   - Production: add `PUBLIC_TURNSTILE_SITE_KEY` (site key) and `TURNSTILE_SECRET_KEY` (secret)
   - **Preview:** add a *different* set keyed to a separate Turnstile site (or skip and disable preview Turnstile by not setting them — the code falls back to a no-op)
4. Redeploy (push any commit, or hit "Retry deployment")

Verification: `/login` should show the Turnstile widget. A failed
challenge returns `200 { ok: true }` (silent — same as rate-limit hit) so
attackers can't distinguish "challenge failed" from "email accepted".

---

## 3. Preview-deploy environment split

Right now every `*.pages.dev` preview shares production Stripe / KV /
Resend keys. A preview URL can mint real checkout sessions and email real
customers.

In Cloudflare Pages → **morphicsmusic-website** → **Settings → Environment
variables**, configure a separate **Preview** env:

| Variable | Production | Preview |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_…` | `sk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` (live endpoint) | `whsec_…` (test endpoint) |
| `PRINTFUL_API_KEY` | live | sandbox |
| `RESEND_API_KEY` | live | test or empty |
| `AUTH_SECRET` | one strong value | a *different* value (so a preview cookie never validates against prod) |
| `DOWNLOADS` (KV namespace) | prod KV id | preview KV id (create a separate namespace) |
| `MASTERS` (R2 bucket) | prod bucket | preview bucket (create a separate bucket; same key layout) |

Alternative if creating a separate KV/R2 is too much: enable
**Cloudflare Access** on `*.pages.dev` so previews are gated behind
Cloudflare login and never publicly reachable. Pages → Settings →
Access → Enable.

---

## 4. WAF managed rules on `/api/*`

Cloudflare dashboard → `morphicsmusic.com` → **Security → WAF → Managed
rules** → enable **Cloudflare Managed Ruleset** at "Block" sensitivity
medium. Add a rule:

- Field: URI Path **starts with** `/api/`
- Action: managed challenge for known bad bots, log everything else

Free on Cloudflare's Pro plan; on Free plan you get a more limited rule
set but still blocks the worst offenders.

---

## 5. Optional / nice-to-haves

- **Drop `script-src 'unsafe-inline'`** — requires moving Astro's
  inline `<script type="module">` blocks (particle canvas in
  `ParticleBackground.astro`, account-link probe in `TopNav.astro`)
  into bundled external files. Astro currently inlines small scripts;
  needs Vite/Astro config tweaks.
- **Rate-limit Durable Object** — replace the KV-based limiter in
  `login.ts` and `checkout.ts` with a Cloudflare Rate Limiting
  binding (now GA on Pages) for proper edge-wide bucketing.
- **Audit R2 bucket public access** — confirm in the Cloudflare R2
  dashboard that the `MASTERS` bucket has no public-access policy
  and no `r2.dev` proxy domain. Files should only be reachable via
  `/api/download` after auth.

---

## What's already shipped (no action needed)

- Stripe webhook now handles `charge.refunded`,
  `charge.dispute.created`, `charge.dispute.funds_withdrawn` — refunds
  and chargebacks revoke the download grant and prune the customer
  record.
- `/api/download` validates the requested R2 key against the masters
  manifest (no path traversal, no IDOR).
- Use-counter increments before streaming + 60s debounce so link-preview
  bots don't burn a buyer's quota.
- Dynamic CORS with `Vary: Origin` allow-listed to
  `morphicsmusic.com` + `www.morphicsmusic.com`.
- Session cookie renamed to `__Host-morphics_auth`, TTL 365→30 days,
  payload now carries a per-user version. Hitting `/api/auth/logout`
  bumps the version in KV — every outstanding cookie is invalidated.
- CSP `img-src` pinned to known hosts; `upgrade-insecure-requests`
  added.
- `/api/library` no longer leaks `stripe_session_id` or `merch_items`.
- Login email now fire-and-forget via `waitUntil` with a 5s timeout —
  removes a timing oracle that distinguished sent-vs-rate-limited.
- `verify.ts` re-validates the magic-link redirect path (defense-in-
  depth open-redirect guard) and sets `Referrer-Policy: no-referrer`.
