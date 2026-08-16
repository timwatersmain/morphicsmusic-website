# Passkey Sign-in — Design

**Date:** 2026-08-16
**Status:** Awaiting review
**Repo:** `~/Desktop/MorphicsBrain/website` (morphicsmusic.com)

---

## 1. Why

Signing in today means leaving the site, opening your email, and clicking a link.
Tim's words: *"I hate that I can't just stay signed in and I hate that I can't log in
with a password — it's janky and not normal."*

Two separate problems sit behind that sentence, and only one of them is about
credentials.

**The "can't stay signed in" half is a bug, not a design flaw.** Sessions already last
30 days. But `TopNav.astro:87` hard-codes the account control to "Sign in" and only
flips it to "Library" when `/api/auth/me` succeeds; line 133 swallows every error. A
rate-limit hit (120/min/IP, called on every page load), a slow response, or a dropped
request all leave the nav asserting you are logged out while a valid session sits in the
browser. `login.astro` then compounds it by never checking for a session, so the page
happily asks a signed-in customer to request a link they do not need.

That is fixed separately and ships first. **It is not in this spec's scope** — it is being
implemented on `feat/fan-community` as its own change, because it is worth having whether or
not passkeys ever land.

**The "log in with a password" half** is this spec. The answer is passkeys, not
passwords, for a measured reason.

## 2. Why not passwords

Passwords need a deliberately slow hash. The only strong KDF in the Workers runtime
without a dependency is PBKDF2, and it is capped twice over:

| Constraint | Value | Source |
|---|---|---|
| Measured cost | 0.59 ms per 1,000 iterations | probe run against workerd locally |
| Cloudflare Free plan CPU ceiling | 10 ms per request | Workers platform limits |
| → iterations that actually fit | **~17,000**, less once KV reads are counted | derived |
| workerd hard cap on PBKDF2 | **100,000**, any plan, deliberate anti-DoS | workerd#1346 |
| OWASP guidance, PBKDF2-HMAC-SHA256 | **600,000** | OWASP |

So the platform tops out 6× under guidance even on a paid plan, and ~35× under it on the
current one. Shipping that would not be "a password system with a caveat" — the shop
holds no card data (Stripe does), so the loss on a leak is not Tim's storefront, it is
every *other* site where a customer reused that password.

Passkeys invert every one of those numbers. Verification is a single ECDSA signature
check — sub-millisecond, nowhere near the CPU ceiling — and there is no password-equivalent
secret stored anywhere to leak. They also deliver the actual request better than a password
does: Face ID or Touch ID, one tap, nothing typed, nothing to forget or reset.

## 3. Scope

**In:** passkey registration, passkey sign-in, passkey management (list/rename/remove),
a longer session on passkey login.

**Out:** passwords in any form. Removing magic links — they stay as the recovery path and
the fallback for devices without passkey support. Social login. 2FA on top of passkeys
(a passkey already carries user verification).

## 4. Decisions taken

| Decision | Choice |
|---|---|
| Credential type | Passkeys (WebAuthn), discoverable/resident preferred |
| Library | `@simplewebauthn/server` — first new runtime dep since Astro/Stripe/Tailwind/three |
| Sign-in flow | **Usernameless** — one tap, no email typed |
| Registration gate | Must already be signed in (via magic link) to add a passkey |
| Recovery | Magic link, unchanged |
| Storage | Credentials on the existing `customer:<email>` KV record |
| Session on passkey login | Longer than 30 days, since re-auth is one tap |

### Why a dependency here

The zero-dependency norm elsewhere in this repo is a good one, and it is being broken
deliberately. Passkey verification means CBOR/COSE decoding, DER signature conversion, and
origin / RP-ID / challenge / replay checks. That is precisely the class of code where a
hand-rolled parser produces a subtle, exploitable bug that tests pass straight over.
`@simplewebauthn/server` is the de-facto standard and ships an ESM build that runs on
Workers.

## 5. Architecture

### 5.1 The two ceremonies

**Registration** (signed-in customer adds a passkey)

1. `POST /api/auth/passkey/register/start` — server generates registration options with a
   fresh random challenge, stores the challenge in KV under a single-use key with a 5-minute
   TTL, returns the options.
2. Browser calls `navigator.credentials.create()`.
3. `POST /api/auth/passkey/register/finish` — server verifies the attestation against the
   stored challenge, then appends the credential to the customer record and writes the
   reverse index.

**Authentication** (anyone signing in)

1. `POST /api/auth/passkey/login/start` — no email required. Server issues a challenge with
   an empty `allowCredentials`, so the browser offers whichever passkeys it holds for this site.
2. Browser calls `navigator.credentials.get()`.
3. `POST /api/auth/passkey/login/finish` — server resolves the returned credential ID to a
   customer, verifies the signature against that credential's stored public key, and on
   success mints the existing session cookie via `signSession()`.

The session is minted by the **existing** `functions/_lib/auth.ts` machinery, unchanged.
Passkeys are a new way to prove who you are; everything downstream of that proof stays
exactly as it is today.

### 5.2 Challenge storage

Challenges live in KV, single-use, 5-minute TTL — the same shape as the existing
`login:<token>` grant. This is not incidental: Cloudflare requests may land on different
edge locations, so an in-memory challenge would fail intermittently and confusingly.

### 5.3 Credential storage, and the user handle

Credentials go on the existing `customer:<email>` record — one identity per person, as with
the fan profile work:

```
passkeys: [{ id, publicKey, counter, transports, created_at, last_used_at, label }]
user_handle: <random opaque id, stable per customer>
```

Plus a reverse index `passkey:<credentialId> → email`, which is what makes usernameless
sign-in possible: the browser hands back only a credential ID, and the server must resolve
it to a customer without being told who they are.

**The user handle must be a random opaque id, never the email.** The handle is stored *on
the authenticator* and can surface in OS-level account pickers. Putting an email there
would leak it into places this project has been careful to keep it out of.

### 5.4 Where customers manage it

A new `/account` page listing sign-in methods: passkeys with their labels, created and
last-used dates, add and remove. Deliberately not bolted onto `/library`, which stays a
download surface.

## 6. Security

- **RP ID is `morphicsmusic.com`.** Passkeys are bound to it, so they will not work on
  `*.pages.dev` preview deployments. Preview testing uses magic links.
- Origin and RP-ID are verified server-side on every ceremony; the library does this, and
  it must be configured with the real values rather than echoing the request.
- Challenges are single-use and deleted on consumption, like the existing login tokens.
- Signature counters are checked where the authenticator provides one. Many passkeys always
  report `0` — that is normal for synced credentials and must not be treated as a failure.
- `userVerification: 'preferred'` — biometric or PIN where available, without locking out
  hardware that cannot do it.
- Removing your last passkey is allowed; magic link remains, so nobody can lock themselves out.
- Rate limits on all four endpoints via the existing `_lib/ratelimit.ts`.
- Registration requires an existing session, so a passkey can only ever be added by someone
  who already proved they own the email.

## 7. Migration

Nothing to migrate. Every existing customer keeps magic-link sign-in exactly as now. Passkeys
are additive: after signing in, customers are offered the chance to add one. No forced flow,
no reset email, no account lockout risk.

## 8. Risks

| Risk | Mitigation |
|---|---|
| First runtime dependency | Deliberate; the alternative is hand-rolled crypto parsing |
| Passkeys don't work on preview deploys | Expected — RP ID is bound to the apex. Use magic links there |
| Customer on an old device with no passkey support | Magic link is unchanged and always available |
| Reverse index drifts from the customer record | Both written in the same handler; a rebuild script can regenerate the index from customer records |
| Synced passkeys report counter 0 | Do not treat a non-incrementing counter as a replay |

## 9. Open questions

1. How long should a passkey session last — 90 days, a year, or until explicitly signed out?
2. Should the login page lead with the passkey button and put the email field behind
   "use email instead", or show both equally?
3. Should customers be *prompted* to add a passkey after a magic-link login, or is it
   opt-in from `/account` only?

None block implementation; all are cheap to change later.
