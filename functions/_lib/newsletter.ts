// Joining the mailing list, in one place.
//
// Two doors reach this: the subscribe form (api/subscribe.ts) and the opt-in
// checkbox on signup (api/auth/signup.ts). They must behave identically — same
// KV record, same Resend push, same welcome mail, same idempotence — because a
// subscriber cannot tell which door they came through and neither can anything
// downstream. Two copies of this would drift the first time one was edited.

export interface NewsletterEnv {
  DOWNLOADS: KVNamespace;
  AUTH_SECRET: string;
  RESEND_API_KEY?: string;
  RESEND_TOPIC_ID?: string;
  ORDER_FROM_EMAIL?: string;
  PUBLIC_SITE_URL?: string;
}

export const subscriberKey = (email: string) => `subscriber:${email}`;

// Deliberately permissive. A format sniff to catch typos and obvious junk, not
// an attempt at RFC 5322 — over-strict patterns reject real addresses
// (plus-tags, new TLDs) and the only real proof an address works is mail
// arriving at it.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

async function addToResendTopic(env: NewsletterEnv, email: string): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.RESEND_TOPIC_ID) return false;
  const res = await fetch('https://api.resend.com/contacts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, topics: [{ id: env.RESEND_TOPIC_ID, subscription: 'opt_in' }] }),
  });
  if (!res.ok) console.error('resend contact create failed:', res.status, await res.text().catch(() => ''));
  return res.ok;
}

/**
 * Add an address to the list. Idempotent: a repeat re-affirms the opt-in in
 * Resend (harmless, and it revives someone who unsubscribed then changed their
 * mind) but sends no second welcome.
 *
 * Never throws. Both callers reach this AFTER the thing the visitor actually
 * asked for has already succeeded — a signup, or a form submit — so a Resend
 * outage must not surface as a failure of that.
 */
export async function subscribeToNewsletter(
  env: NewsletterEnv,
  rawEmail: string,
  source: string,
): Promise<{ ok: boolean; isNew: boolean }> {
  const { sendWelcomeEmail } = await import('./emails');
  const email = normaliseEmail(rawEmail);
  if (!email) return { ok: false, isNew: false };
  try {
    const existingRaw = await env.DOWNLOADS.get(subscriberKey(email));
    let record: any = null;
    if (existingRaw) { try { record = JSON.parse(existingRaw); } catch { record = null; } }
    const isNew = !record;
    const now = Math.floor(Date.now() / 1000);
    record = record || { email, first_seen_at: now, source };
    record.last_seen_at = now;
    // No TTL — this is a permanent record of consent, and the date someone
    // opted in is exactly what you need if a complaint is ever answered.
    await env.DOWNLOADS.put(subscriberKey(email), JSON.stringify(record));
    await addToResendTopic(env, email);
    if (isNew) await sendWelcomeEmail(env as any, email);
    return { ok: true, isNew };
  } catch (e) {
    console.error('subscribeToNewsletter failed:', e);
    return { ok: false, isNew: false };
  }
}
