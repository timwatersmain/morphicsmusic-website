# STACK.md — Recon for the Download Gate

Phase 0 deliverable. Written from a read-only pass over the repo at commit `514ba70`
plus a fetch of SoundCloud's current developer docs. **No feature code written.**

Repo root: `~/Desktop/MorphicsBrain/website` (the brief said "root of the morphicsmusic
repo" — this is it; `github.com/timwatersmain/morphicsmusic-website`).

---

## 1. Stack inventory

| Thing | What it actually is |
|---|---|
| Framework | **Astro 6.1** (`package.json:24`), static output. No SSR adapter — `astro.config.mjs` has no `output`/`adapter`, so every `src/pages/*.astro` is prerendered to HTML at build time. |
| Dynamic server code | **Cloudflare Pages Functions** in `functions/` — plain TypeScript modules exporting `onRequestGet` / `onRequestPost` / `onRequestOptions`. Not Astro endpoints. |
| Language | TypeScript for `functions/`, `.astro` + vanilla ES modules for the client. `tsconfig.json` extends `astro/tsconfigs/strict`. |
| Package manager | **npm** (`package-lock.json`, no pnpm/yarn lockfile). Node `>=22.12.0`. |
| CSS | **Tailwind 4** via `@tailwindcss/vite`. Material-3-derived token palette in `tailwind.config.mjs:7-55`. `borderRadius` is globally `0px` (`tailwind.config.mjs:61-66`) — square corners are a deliberate brand rule. |
| Build | `npm run build` → `astro build`. A `prebuild` hook (`package.json:13`) regenerates `src/data/music-catalog.json` from the Brain DB — **hand-edits to that file are clobbered on every build.** |
| Deploy target | **Cloudflare Pages**, project `morphicsmusic-website`. `.github/workflows/deploy.yml` does nothing but `curl` a CF deploy hook on push to `main`. Deploy = push to main. |
| Tests | **Vitest 3** (`vitest.config.js`), `environment: 'node'`, `include: ['tests/**/*.test.js']`. Seven test files, all covering the landing-page spelling engine. **Zero tests touch `functions/`.** No miniflare/workers test harness. |
| Lint / format | **None.** No eslint, prettier, biome, or editorconfig anywhere. |

### Database — read this carefully

**There is no SQL database, no ORM, and no migration system.** This is the single
biggest gap between the brief and reality. Persistence is two Cloudflare primitives
plus build-time JSON:

- **KV**, binding `DOWNLOADS` (namespace `MORPHICS_DOWNLOADS`). Every mutable record
  lives here as a JSON blob under a string key:
  | Key pattern | Contents | TTL |
  |---|---|---|
  | `customer:<email>` | the customer record — this is the user table | **none, permanent** |
  | `grant:<token>` | 7-day download grant | 7d |
  | `grant_session:<stripe_session_id>` | reverse index for refund revocation | 7d |
  | `pi:<payment_intent>` | reverse index → `{email, session_id}` | none |
  | `login:<token>` | magic-link grant | 15 min |
  | `session_ver:<email>` | session kill-switch counter | none |
  | `fulfillment:<session_id>` | cart plan handed from checkout to webhook | 7d |
  | `webhook:completed:<event_id>` / `webhook:in_progress:<id>` | Stripe idempotency | 30d / 5min |
  | `rl:<scope>:<bucket>:<id>` | rate-limit counters | per-window |
  | `dl_recent:<token>:<file>` | link-preview-bot debounce | 60s |
- **R2**, binding `MASTERS` (bucket `morphicsbrain-media`). Prefixes: `masters/<slug>/`
  (lossless, gated), `previews/<slug>/` (128k MP3, public), `digital/<slug>/` (fonts/packs).
- **Build-time JSON** in `src/data/` — `music-catalog.json`, `digital.json`,
  `merch.json`, `masters-manifest.json`, `previews.json`. These are **imported directly
  into the Functions** (`functions/api/download.ts:10-12`) and therefore act as
  compile-time allow-lists. Changing a product means a rebuild + redeploy.

There is **no `wrangler.toml`**. Bindings and env vars are configured only in the
Cloudflare Pages dashboard (`STORE-SETUP.md:32-49`). Any new binding is a manual
dashboard step, not a code change.

### Where secrets live

Cloudflare Pages → Settings → Environment variables (Production), set via
`pbpaste | wrangler pages secret put NAME --project-name morphicsmusic-website`.
Currently referenced by `functions/`:

`AUTH_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`,
`PRINTFUL_API_KEY`, `TURNSTILE_SECRET_KEY`, `PUBLIC_SITE_URL`, `ORDER_FROM_EMAIL`,
plus bindings `DOWNLOADS` (KV) and `MASTERS` (R2).

Client-side: only `PUBLIC_TURNSTILE_SITE_KEY` (`src/pages/login.astro:7`).

**There is no `.env.example`.** `.env` is gitignored (`.gitignore:17`) and is used
only by local Node scripts (`PRINTFUL_API_KEY`). Deliverable requirement #6 means
creating `.env.example` from scratch.

---

## 2. Integration points

### 2.1 Magic-link auth, end to end

Fully reusable. This is the best-built part of the codebase.

1. **Request** — `POST /api/auth/login` (`functions/api/auth/login.ts:53`). Validates
   email shape (`:57`), verifies Turnstile if `TURNSTILE_SECRET_KEY` is set — and
   **no-ops the challenge when it is unset** (`:20`), which is exactly the
   degrade-silently pattern Phase 6 asks for. Rate limits 5/10min/IP + 3/hr/email
   (`:74-75`). Always returns `{ok:true}` regardless of outcome, so nothing leaks
   whether an address exists (`:123`).
2. **Token generation** — `issueLoginToken()` (`functions/_lib/auth.ts:142-155`):
   24 random bytes, base64url, stored at `login:<token>` with a **15-minute** TTL
   (`LOGIN_TTL_MINUTES`, `:9`). Redirects are path-only-validated at both issue
   (`login.ts:42-49`) and consume (`verify.ts:16-22`) to prevent open redirect.
3. **Email** — sent inline via Resend inside `waitUntil` (`login.ts:97-121`),
   deliberately fire-and-forget so response timing doesn't leak rate-limit state.
   From-address self-heals away from `@resend.dev` (`:94`).
4. **Consume** — `GET /api/auth/verify?token=` (`functions/api/auth/verify.ts:24`).
   `consumeLoginToken()` (`auth.ts:157-166`) is **one-shot — deletes on read.**
   Returns a 303 with `Set-Cookie` + `Referrer-Policy: no-referrer`.
5. **Session** — `signSession()` (`auth.ts:50-55`) HMAC-SHA256 over `email|exp|ver`,
   30-day TTL. Cookie `__Host-morphics_auth` (`:10`), `HttpOnly; Secure; SameSite=Lax`
   (`:107-123`). `verifySession()` (`:73-105`) is constant-time and re-checks `ver`
   against `session_ver:<email>` in KV, giving a per-user revocation kill-switch
   (`bumpSessionVer`, `:67-71`).

**For the gate:** double opt-in is this exact flow with a different email body and a
different redirect target. `issueLoginToken` already accepts a `redirect` — a
confirmation link can land on `/unlock/<slug>?confirmed=1`. No new token machinery needed.

### 2.2 User / customer schema, and how library access is granted

The customer record is the user table. Written in
`recordCustomerPurchase()` (`functions/api/stripe-webhook.ts:141-199`), typed at
`stripe-webhook.ts:121-137`:

```ts
interface CustomerRecord {
  email: string;
  name?: string | null;
  first_seen_at: number;
  last_seen_at: number;
  purchases: CustomerPurchase[];   // { purchased_at, stripe_session_id,
}                                  //   music_release_slugs, digital_slugs,
                                   //   merch_items, amount_total, currency }
```

Stored at `customer:<lowercased email>` **with no TTL** (`:184-185`). Access is
computed, not stored: `/api/library` (`functions/api/library.ts:52-55`) and the
cookie path of `/api/download` (`functions/api/download.ts:122-131`) both roll up
`purchases[].music_release_slugs` / `digital_slugs` into an owned-set and check
membership. **Granting library access = appending a purchase entry.** Nothing else.

This is the hook for "a free gate item lands in the existing library" — and it can be
done without touching `checkout.ts` or `stripe-webhook.ts` at all.

### 2.3 How a product is defined, and how a purchase grants a download

- Music: `src/data/music-catalog.json` (auto-generated), name-your-price with
  `min_price_cents`, gated by `isReleased()` (`functions/_lib/release-gate.mjs:27`).
- Fixed-price digital (fonts, packs): `src/data/digital.json` — the closest existing
  analogue to a gate file. Shape includes `file: { r2_key, filename }`, and that
  `r2_key` **is** the download allow-list (`download.ts:61-66`).
- Upload path: `scripts/upload-digital.mjs` pushes each product's file to the exact
  declared `r2_key` via `wrangler r2 object put --remote` (`:54-72`), so
  "what's uploaded" and "what's downloadable" can't drift.
- Purchase → grant: `issueDownloadGrant()` (`stripe-webhook.ts:93-119`) mints a
  48-hex-char token, stores `grant:<token>` for 7 days, plus a reverse index for
  revocation. Email sent by `sendDownloadEmail()` (`:226-267`).

### 2.4 Signed / expiring download URLs — **this function does not exist**

The brief says "Quote the exact function" that generates signed or expiring storage
URLs. I grepped for `presign`, `signedUrl`, `aws4`, `AwsClient`, `X-Amz`, `S3Client`
across `src/`, `functions/`, and `scripts/`. **Zero matches.**

The site does not sign storage URLs. It **proxies the bytes through the Worker**:

```ts
// functions/api/download.ts:224-236
const obj = await env.MASTERS.get(key);
if (!obj) return new Response('file not found', { status: 404 });
return new Response(obj.body, {
  headers: {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'private, no-store',
  },
});
```

The R2 bucket has no public access (memory: "R2 public off"), so the only reachable
path to a master is through an authorised Worker call. Two authorisation paths exist:
a cookie-authenticated one with no expiry and no use cap (`:105-144`), and a
token path with a 7-day expiry and `MAX_USES = 5` (`:37`, enforced `:200-202`).

Security controls already in place on that path, all reusable:
- `parseAndValidateKey()` (`:68-82`) — rejects NULs, backslashes, `.`/`..`/dot-prefixed
  segments, over-long keys, and requires an **exact match against the manifest**.
- `safeContentDispositionName()` (`:87-89`) — allow-lists `[\w.\- ]` so a crafted
  filename can't inject `"`/CR/LF into the header.
- A 60s debounce (`:208-222`) so Slack/Gmail/Discord link-preview prefetches don't
  burn the buyer's 5 uses.

**Known limitation, documented in the code** (`:213-217`): KV has no compare-and-swap,
so the use cap is best-effort under concurrency. It's bumped pre-stream to shrink the race.

### 2.5 Transactional email

**Resend**, called with raw `fetch` — no SDK. Two call sites, no template system,
no shared helper; the HTML is inline in each:

- `functions/api/auth/login.ts:97-121` — the sign-in link.
- `functions/api/stripe-webhook.ts:226-267` — `sendDownloadEmail()`, the purchase
  delivery mail.

Both use the same dark inline-styled card (`#0a0a0f` bg, `#e8e8ec` text, white
block button, monospace uppercase CTA). A gate would add a third — and this is
the point at which extracting a small shared `_lib/email.ts` becomes worth it.

Sender resolves to `orders@morphicsmusic.com`; `morphicsmusic.com` is verified in
Resend as of 2026-08-09.

### 2.6 Where files live

| Asset | Location |
|---|---|
| Lossless masters | R2 `morphicsbrain-media`, `masters/<slug>/` |
| MP3 previews | R2, `previews/<slug>/` — served publicly + Range-enabled by `functions/api/preview.ts`, allow-listed from `previews.json` (`:14-18`) |
| Digital products | R2, `digital/<slug>/` |
| Artwork, video, fonts | Repo, `public/images/…`, `public/videos/…`, `public/fonts/…` |
| One existing free file | `public/downloads/Morphian-Trial.zip` — currently a plain public URL, ungated |

### 2.7 Existing analytics or pixel code

**None.** No `gtag`, `fbq`, `dataLayer`, Plausible, Umami, or PostHog anywhere in
`src/`, `functions/`, or `public/`. (The `pixel` grep hits are canvas
`devicePixelRatio` maths.) Phase 6 is entirely greenfield.

This matters more than it sounds, because of the CSP at `public/_headers:8`:

```
script-src 'self' 'unsafe-inline' https://www.tiktok.com https://bandcamp.com
           https://*.bandcamp.com https://js.stripe.com https://challenges.cloudflare.com;
connect-src 'self' https://api.stripe.com https://challenges.cloudflare.com;
```

A Meta Pixel needs `https://connect.facebook.net` in `script-src` and
`https://www.facebook.com` in `connect-src`/`img-src`; GA4 client-side needs
`https://www.googletagmanager.com` + `https://*.google-analytics.com`. **Every
client-side pixel is a CSP edit.** The server-side halves (CAPI, GA4 Measurement
Protocol) need no CSP change at all, since they're `fetch` from the Worker.

### 2.8 Anti-abuse primitives already built

`functions/_lib/ratelimit.ts` — fixed-window KV counter, `rateLimit(env, scope,
bucket, id, limit, windowSec)` (`:22-38`), with `rateLimitedJson()` / `rateLimitedText()`
responses that set `Retry-After` (`:42-62`) and `clientIp()` reading `CF-Connecting-IP`
(`:64-66`). Directly reusable for Phase 7 — a new `gate` scope is a one-liner.

Turnstile verification already exists as `verifyTurnstile()` (`login.ts:19-38`) but
is **local to that file**, not exported. Phase 7 would lift it into `_lib/`.

`functions/_lib/cors.ts` — origin allow-list (`:4-7`) and a `corsHandler()` wrapper
(`:34-39`) that every `/api/*` function is already wrapped in.

---

## 3. Proposed plan

### 3.1 Shape of the integration

Reuse, verbatim: `_lib/auth.ts` (all of it), `_lib/ratelimit.ts`, `_lib/cors.ts`, the
`customer:<email>` record, the Resend call pattern, the R2-proxy download pattern,
the Turnstile pattern, and the Tailwind token palette.

New surface, all additive:

```
functions/api/gate/[slug].ts        GET   public gate config + view event
functions/api/gate/start.ts         POST  begin an action (arm dwell timer / issue OAuth state)
functions/api/gate/verify.ts        POST  resolve one action → verified | attested | failed
functions/api/gate/email.ts         POST  email + consent → double-opt-in send
functions/api/gate/unlock.ts        POST  all required actions satisfied → grant + email
functions/api/gate/redeem.ts        GET   single-use 60s token → stream the file
functions/api/oauth/soundcloud/start.ts     GET  PKCE authorize redirect
functions/api/oauth/soundcloud/callback.ts  GET  code → token, cached server-side
functions/_lib/gate/verifiers/*.ts  the pluggable verifier interface
functions/_lib/email.ts             extracted shared Resend helper
src/pages/unlock/[slug].astro       the public page
```

Delivery reuses `recordCustomerPurchase`'s data shape: on unlock, append a purchase
entry with `amount_total: 0` and a `source: 'gate:<slug>'` marker to
`customer:<email>`. The file then shows in `/library` forever through the code
that already exists, with **no change to `checkout.ts` or `stripe-webhook.ts`.**

### 3.2 Corrections to the brief, before you approve anything

Six places where the brief assumes something this repo doesn't have. I'd rather
flag them now than build a plausible-looking version of each.

1. **Phase 1 is unbuildable as written.** "Add tables… migrations must be reversible"
   presumes SQL. There is no database and no migration runner. See decision 1.
2. **Phase 4's "redeems for a signed storage URL" doesn't match how this site
   works** — and the existing way is stricter. A presigned R2 URL is a bearer
   credential that lives in browser history and referrer headers for its whole
   lifetime. The current design never emits a storage URL at all; the Worker
   authorises then streams. I'd keep that, and make the 60s single-use token
   redeem for **the bytes**, not for a URL. This satisfies "the raw file must never
   be reachable by a guessable public URL" more completely than presigning does.
   Say the word if you want true presigning and I'll add an S3 signer — but I don't
   recommend it.
3. **Phase 5 has nothing to protect the admin with.** There is no admin route,
   no role field, no `ADMIN_EMAILS` var, nothing. The brief says ask first. Decision 4.
4. **Repost verification is the shakiest of the four SoundCloud checks.**
   `GET /me/reposts/tracks` is in the current public spec, but SoundCloud's own
   issue tracker carries a long history of reposts being unreadable through the
   public API (issues #2, #62, #379). I'll build it behind the verifier interface
   and test it against your real account early. **If it doesn't return data, I
   will tell you and mark repost `attested` — I won't fake a verified result.**
5. **The client-credentials rate limit is mostly a red herring for this feature.**
   50/12h per app + 30/hr per IP applies to the *client_credentials* grant. Per-visitor
   follow/like/repost checks require the **authorization_code** grant — the visitor
   OAuths into their own SoundCloud account, and each visitor gets their own token.
   Client credentials would only be used for app-level reads (resolving a track URL
   to an ID, reading a track's public comment list). Those I'll cache aggressively:
   one long-lived token in KV with refresh-token rotation, plus a cached URN per
   configured target so `/resolve` is called approximately never. Confirmed from the
   docs: PKCE (S256) is **required**, and all clients are confidential, so the
   secret stays server-side — which is fine, the exchange happens in the Worker.
6. **Preview deployments share the production KV namespace** (`SECURITY-OPS.md:74`).
   Any gate you create is instantly live-ish across every preview URL, and gate
   rate-limit counters are shared. Worth knowing before the first campaign.

Two smaller things I noticed and am *not* touching, since they're outside scope and
the brief says don't refactor unrelated code:

- `FulfillmentEntry.type` is typed `'merch' | 'music'` (`stripe-webhook.ts:17`) but
  the code filters for `'digital'` in three places (`:174`, `:383`). It works because
  the array is `any[]` at the checkout end; the type is just wrong.
- `README.md` is still the stock Astro template.

### 3.3 New dependencies

I'd like to add **zero runtime dependencies**. Specifically:

| Need | How, without a dep |
|---|---|
| PKCE S256 challenge | `crypto.subtle.digest('SHA-256')` — already used in `_lib/auth.ts:28-38` |
| IP / UA hashing | same, HMAC'd with `AUTH_SECRET` so hashes aren't rainbow-table-able |
| SoundCloud API calls | `fetch`, like Resend/Printful/Turnstile already do |
| Meta CAPI + GA4 MP | `fetch` |
| CSV export | ~15 lines of RFC-4180 quoting |
| Disposable-domain blocklist | a checked-in `.json` list, no package |

The only candidate would be an S3 signer for R2 presigning (`aws4fetch`, ~3KB),
and only if you overrule recommendation 2 above. **I'll ask before adding anything.**

### 3.4 Decisions I need from you

1. **Where does gate data live — Cloudflare D1, or KV?**
   *My recommendation: D1.* D1 is SQLite on Cloudflare, free-tier-sufficient here,
   and gives you the actual tables and reversible migrations the brief asks for.
   It matters most for Phase 5: per-gate funnel stats and "top UTM sources" are
   `GROUP BY` queries. In KV that's a full `list()` + fetch of every unlock row on
   every admin page load, which degrades badly the moment a campaign works.
   Cost: one new dashboard binding, and a second storage system in the codebase.
   The alternative is KV-only, consistent with everything else, but stats get
   precomputed into counters and ad-hoc questions become unanswerable.
   *Auth, sessions, and rate limits stay in KV either way.*

2. **Does a free gate unlock write into `customer:<email>` — creating a permanent
   account record for someone who never paid?**
   I think yes: it's what makes `/library` "just work" and matches the brief. But it
   does mean `/library` and your customer list now mix buyers and freebie-claimers.
   I'd add a `source: 'gate:<slug>'` marker on the purchase entry so they're always
   distinguishable, and never label a gate claimer as a customer in exports.
   Confirm, or tell me to keep gate contacts in a separate keyspace.

3. **Gate file storage: R2 `gates/<slug>/` — and are gate files uploaded through the
   admin UI, or dropped via a script like `upload-digital.mjs`?**
   Pages Functions have a request-body size ceiling (100 MB on the free plan), so a
   large stem pack can't go through a browser upload. Script-based upload is more
   robust; admin upload is what acceptance criterion 1 ("create a gate in under 2
   minutes with no code changes") implies. I can do admin-upload with a
   script fallback for big files, if you want both.

4. **How do I authenticate the admin?** No admin check exists. Options, cheapest first:
   (a) an `ADMIN_EMAILS` env var checked against the existing session cookie — reuses
   all the auth you already have, one new env var; (b) Cloudflare Access in front of
   `/admin/*` — zero app code, free tier covers it, but a dashboard setup step;
   (c) a separate shared admin secret. *I'd pick (a).*

5. **SoundCloud credentials — do you have Artist Pro, and has an API app been
   registered?** I need `SOUNDCLOUD_CLIENT_ID` + `SOUNDCLOUD_CLIENT_SECRET` and a
   registered redirect URI (`https://morphicsmusic.com/api/oauth/soundcloud/callback`)
   before any of Mode A can be tested for real. If that's not in place, I'll build
   the interface and ship it in attested mode with a config flag, then flip it.

6. **Are you willing to loosen the CSP for client-side pixels?** Meta Pixel and GA4
   client-side both require new `script-src`/`connect-src` origins. The server-side
   halves (CAPI + Measurement Protocol) need no CSP change. If you'd rather not
   touch the CSP, I can ship **server-side-only** tracking — you lose some
   attribution fidelity but keep the tight policy. Note the brief itself requires
   *both* halves for deduplication, so I need your call here.

7. **Can I extend `vitest.config.js` to cover `functions/`?** The current
   `include` is `tests/**/*.test.js` only, and the verification engine is TypeScript.
   I'd add `tests/**/*.test.ts` and keep verifiers as pure functions taking an
   injected fetch, so they test without a workers runtime. No new dependency.

8. **Do we honour Do Not Track / need a cookie banner?** UTM capture and server-side
   pixels on an EU-reachable site is a consent question, and there's no consent
   infrastructure on the site today. The marketing checkbox in Phase 3 covers email
   consent, not analytics consent. Tell me how far you want to go.

---

## 4. Verified vs attested — the honest table

Draft for `docs/DOWNLOAD_GATE.md`, stated here so it's agreed before code exists.

| Action | Mode | Why |
|---|---|---|
| SoundCloud follow | **verified** | `GET /me/followings` after visitor OAuth |
| SoundCloud like | **verified** | `GET /me/likes/tracks` |
| SoundCloud comment | **verified** | `GET /tracks/{id}/comments`, match authed user id |
| SoundCloud repost | **verified — pending live test** | `GET /me/reposts/tracks` is in the spec but historically unreliable. Demoted to attested if it doesn't work, and the docs will say so. |
| Email | **verified** | double opt-in, confirmation click required before unlock |
| Spotify | **attested** | Web API needs Extended Quota Mode (~250k MAU + business entity). Not achievable. **No follow check will be written.** |
| Instagram, TikTok, YouTube, Bandcamp, Facebook, X | **attested** | no public read API for "did this user follow me" |

Attested = opened in a new tab, 6-second dwell timer, recorded as `attested`.
It will never be written, displayed, or exported as `verified`.

---

**Sources for the SoundCloud claims:**
[Rate limits](https://developers.soundcloud.com/docs/api/rate-limits) ·
[API guide (OAuth, PKCE, confidential clients)](https://developers.soundcloud.com/docs/api/guide) ·
[Public API spec / endpoint list](https://developers.soundcloud.com/docs/api/explorer/open-api) ·
[URN migration notice](https://developers.soundcloud.com/blog/urn-num-to-string/) ·
[Reposts unreadable — issue #379](https://github.com/soundcloud/api/issues/379)

**Stopping here for approval, as instructed. No Phase 1 work started.**
