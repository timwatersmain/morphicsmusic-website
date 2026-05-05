# Morphics Store — Setup

Everything is built. To go live you need to (1) create three free accounts, (2) paste keys into Cloudflare Pages env vars, (3) drop master audio files into `~/Desktop/Morphics Masters/`, and (4) deploy.

No monthly fees. Costs only when you make a sale (Stripe per-transaction, Printful per-order).

---

## 1. Account signups

### Stripe — `https://dashboard.stripe.com/register`
1. Email: `morphicsmusic@gmail.com`. Skip the "activate live payments" step for now — test mode works without KYC.
2. Dashboard → top-right toggle to **Test mode**.
3. Developers → API keys → copy **Secret key** (`sk_test_…`). Save for step 2.
4. (Later, when going live) Settings → Activate payments → submit business info + bank.

### Printful — `https://www.printful.com/dashboard/store`
1. Confirm you have a store with the 6 merch items (you do — `merch.json` was synced from there).
2. Settings → API → **Generate token**. Copy.

### Resend — `https://resend.com/signup`
1. Sign up with `morphicsmusic@gmail.com`.
2. Add `morphicsmusic.com` as a domain → add the DNS records in Cloudflare. Verifies in <10 min.
3. API Keys → Create → copy.

### Cloudflare R2 + KV (already in your CF account)
1. Cloudflare dashboard → **R2** → reuse existing `morphicsbrain-media` bucket (audio masters land under `masters/` prefix).
2. **Workers & Pages** → KV → Create namespace `MORPHICS_DOWNLOADS`. Copy the namespace ID.

---

## 2. Cloudflare Pages env vars + bindings

Pages dashboard → your `morphicsmusic-website` project → **Settings**:

**Environment variables (Production):**
| Name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` (swap to `sk_live_…` when going live) |
| `STRIPE_WEBHOOK_SECRET` | (filled in step 4) |
| `PRINTFUL_API_KEY` | from Printful |
| `RESEND_API_KEY` | from Resend |
| `PUBLIC_SITE_URL` | `https://morphicsmusic.com` |
| `ORDER_FROM_EMAIL` | `orders@morphicsmusic.com` |

**Functions → Bindings:**
- **R2 bucket** → Variable name `MASTERS`, bucket `morphicsbrain-media`
- **KV namespace** → Variable name `DOWNLOADS`, namespace `MORPHICS_DOWNLOADS`

Save. Trigger a redeploy.

---

## 3. Sync product data + upload masters

Run these locally — they regenerate the JSON the site builds against.

```bash
cd ~/Desktop/MorphicsBrain/website

# Put your Printful + (later) Stripe keys in a .env file for scripts:
cat > .env <<EOF
PRINTFUL_API_KEY=pf_…
EOF

npm run sync:printful   # full variant data → src/data/merch.json
npm run sync             # releases + tracks → src/data/music-catalog.json
```

### Drop master audio in `~/Desktop/Morphics Masters/`

Folder layout — folder name should match the release title (case/space insensitive):

```
~/Desktop/Morphics Masters/
├── NEXUS/
│   ├── 01 Telepathine.flac
│   ├── 02 Phantom.flac
│   ├── 03 Lucent.flac
│   └── 04 Numinous.flac
├── METANOIA/
│   └── 01 Metanoia.flac
└── Golden Dawn/
    └── 01 Golden Dawn.flac
```

Accepted: `.flac` `.wav` `.aiff` `.mp3`. Track-number prefixes (`01 `, `1.`, etc.) help match files to track rows.

Upload to R2:

```bash
# First time only:
npx wrangler login

# Upload + update manifest:
npm run upload:masters

# Just regenerate the manifest without re-uploading:
node scripts/upload-masters.mjs --manifest-only
```

Re-run `npm run sync` to refresh `has_masters` flags, then `git push` to redeploy.

---

## 4. Connect Stripe webhook

After Pages redeploys with env vars and bindings:

1. Stripe Dashboard → Developers → **Webhooks** → Add endpoint
2. URL: `https://morphicsmusic.com/api/stripe-webhook`
3. Events: select **`checkout.session.completed`** (just that one).
4. Copy the **Signing secret** (starts with `whsec_…`).
5. Paste into Cloudflare Pages env var `STRIPE_WEBHOOK_SECRET`. Redeploy.

---

## 5. Test purchase (test mode)

1. Go to `https://morphicsmusic.com/store`
2. Add a music release + a merch item to cart.
3. Checkout → Stripe redirects you to its hosted page.
4. Use test card: `4242 4242 4242 4242`, any future date, any CVC, any ZIP.
5. After payment:
   - Music: download email arrives within ~30s. Click → `/download?token=…` → file list with download buttons.
   - Merch: confirm Printful received the order at `printful.com/dashboard/orders`. **Cancel it** before fulfillment so you're not charged for the test.

Verify the Stripe webhook fired: Dashboard → Developers → Webhooks → your endpoint → Recent events → `200 OK`.

---

## 6. Going live

When you're ready to take real money:

1. Stripe → activate payments (KYC: ID + bank).
2. Replace `STRIPE_SECRET_KEY` in Cloudflare with the **live** `sk_live_…` key.
3. Create a **live-mode** webhook endpoint at the same `/api/stripe-webhook` URL, copy the new signing secret, replace `STRIPE_WEBHOOK_SECRET`.
4. Redeploy.

That's it. Each sale: Stripe takes 2.9% + 30¢, Printful charges product+ship cost. No other fees.

---

## File map

| File | What |
|---|---|
| `src/pages/store.astro` | Store landing — music + merch grids |
| `src/pages/store/music/[slug].astro` | Per-release page, name-your-price |
| `src/pages/store/merch/[slug].astro` | Per-merch page, size/color picker |
| `src/pages/download.astro` | Token-gated download page |
| `src/pages/order-complete.astro` | Post-Stripe success page |
| `src/components/Cart.astro` | Floating cart + drawer (in BaseLayout) |
| `src/scripts/cart.js` | localStorage cart logic |
| `functions/api/checkout.ts` | Builds Stripe Checkout Session |
| `functions/api/stripe-webhook.ts` | Verifies + fans out to Printful + Resend |
| `functions/api/download.ts` | Token-gated R2 streaming |
| `scripts/sync-printful.mjs` | Pulls products + variants from Printful |
| `scripts/sync-music-catalog.mjs` | Releases + tracks from MorphicsBrain DB |
| `scripts/upload-masters.mjs` | Uploads `~/Desktop/Morphics Masters/` to R2 |

---

## Adding a release later

1. Add the release + tracks in MorphicsBrain (the DB is already the source of truth).
2. Drop FLACs into `~/Desktop/Morphics Masters/<Release Title>/`.
3. `npm run sync && npm run upload:masters && git push`.
