// Shared customer-record helpers. The single record `customer:<email>` is
// written today ONLY by the Stripe webhook (recordCustomerPurchase in
// functions/api/stripe-webhook.ts) for people who've bought something.
// Signup needs to create that same record for someone who has never
// purchased, WITHOUT touching stripe-webhook.ts (money-path file — off
// limits) — hence this shared read/write helper instead of a second
// hand-rolled writer.
//
// recordCustomerPurchase already does a read-modify-write that only ever
// sets email/name/last_seen_at/purchases and leaves unrecognized fields
// alone, so once username/password fields exist on a record, a later
// purchase can't clobber them — it just doesn't touch them.

export interface CustomerPurchase {
  purchased_at: number;
  stripe_session_id: string;
  music_release_slugs: string[];
  digital_slugs?: string[];
  merch_items: Array<{ printful_variant_id?: number; quantity: number }>;
  amount_total: number;
  currency: string;
}

export interface CustomerRecord {
  email: string;
  name?: string | null;
  first_seen_at: number;
  last_seen_at: number;
  purchases: CustomerPurchase[];
  // Added for username/password auth. Optional so every pre-existing record
  // (purchase-only, no password ever set) stays valid.
  username?: string;
  username_lower?: string;
  password?: string; // the self-describing hash string from _lib/password.ts
  password_updated_at?: number;
  // Set once, by functions/api/auth/verify-email.ts, when the customer
  // clicks a verification link. Absent/undefined means unverified — every
  // record that predates this field (i.e. every customer as of launch) is
  // unverified, which is intentional: verification records a fact, it does
  // not gate anything today.
  email_verified_at?: number;
  // Free-song token: granted once, by functions/api/auth/verify-email.ts, the
  // first time a customer's verify-email token is consumed. `granted_at`
  // being set means "this customer has ever been granted a token" — it is
  // NOT re-granted on subsequent verifications, so it also doubles as the
  // dedupe guard against accumulating tokens from repeat verifies.
  // `spent_key` is the exact R2 master key (never a release slug, never a
  // wildcard) the fan chose to redeem it against, set once by
  // functions/api/free-token.ts and permanent from then on.
  free_token_granted_at?: number;
  free_token_spent_key?: string;
  free_token_spent_at?: number;
}

export interface CustomerEnv {
  DOWNLOADS: KVNamespace;
}

export function customerKey(email: string): string {
  return `customer:${email.toLowerCase().trim()}`;
}

export function usernameKey(usernameLower: string): string {
  return `username:${usernameLower}`;
}

export async function getCustomerRecord(env: CustomerEnv, email: string): Promise<CustomerRecord | null> {
  const raw = await env.DOWNLOADS.get(customerKey(email));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function getCustomerByUsername(env: CustomerEnv, usernameLower: string): Promise<CustomerRecord | null> {
  const email = await env.DOWNLOADS.get(usernameKey(usernameLower));
  if (!email) return null;
  return getCustomerRecord(env, email);
}

// Create a bare customer record for someone who has never purchased —
// used by signup. If a record already exists (e.g. a past purchase), it is
// returned unchanged; callers that need to add credentials should merge
// onto it themselves and call saveCustomerRecord.
export async function getOrCreateCustomerRecord(env: CustomerEnv, email: string): Promise<CustomerRecord> {
  const existing = await getCustomerRecord(env, email);
  if (existing) return existing;
  const now = Math.floor(Date.now() / 1000);
  const record: CustomerRecord = {
    email: email.toLowerCase().trim(),
    name: null,
    first_seen_at: now,
    last_seen_at: now,
    purchases: [],
  };
  return record;
}

export async function saveCustomerRecord(env: CustomerEnv, record: CustomerRecord): Promise<void> {
  // No TTL — customer records persist permanently, matching stripe-webhook.ts.
  await env.DOWNLOADS.put(customerKey(record.email), JSON.stringify(record));
}

export async function saveUsernameIndex(env: CustomerEnv, usernameLower: string, email: string): Promise<void> {
  await env.DOWNLOADS.put(usernameKey(usernameLower), email.toLowerCase().trim());
}

// Delete a stale reverse-index entry when a customer changes their username.
// Without this the old name keeps resolving (and logging in) forever, and
// nobody else can ever claim it.
export async function deleteUsernameIndex(env: CustomerEnv, usernameLower: string): Promise<void> {
  await env.DOWNLOADS.delete(usernameKey(usernameLower));
}
