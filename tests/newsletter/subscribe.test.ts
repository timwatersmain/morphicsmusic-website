import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// Moved to _lib/newsletter when the opt-in checkbox on signup started
// sharing this path — one implementation, two doors.
import { normaliseEmail, subscriberKey } from '../../functions/_lib/newsletter';
import { signUnsubscribe, verifyUnsubscribe } from '../../functions/_lib/auth';

describe('normaliseEmail', () => {
  it('lowercases and trims, so the same person is one row not three', () => {
    expect(normaliseEmail('  Tim@Example.COM ')).toBe('tim@example.com');
    expect(subscriberKey(normaliseEmail('Tim@Example.com')!)).toBe('subscriber:tim@example.com');
  });

  it('accepts the real-world addresses an over-strict pattern would reject', () => {
    // Rejecting these is the classic own goal: they are all valid and all
    // belong to people who would never find out why they never got the email.
    for (const e of [
      'tim+newsletter@example.com',
      'a@b.co',
      'first.last@sub.domain.example.museum',
      "o'brien@example.com",
      'x_y-z@example-domain.io',
    ]) {
      expect(normaliseEmail(e), e).toBe(e.toLowerCase());
    }
  });

  it('rejects the things that are not addresses', () => {
    for (const e of ['', '   ', 'nope', 'no@domain', 'a@@b.com', 'a b@c.com', 'a@b .com', null, undefined, 42, {}]) {
      expect(normaliseEmail(e as any)).toBeNull();
    }
  });

  it('rejects an address longer than the 254-char limit rather than storing it', () => {
    expect(normaliseEmail(`${'a'.repeat(250)}@example.com`)).toBeNull();
  });
});

describe('unsubscribe tokens', () => {
  const SECRET = 'test-secret-value';

  it('round-trips', async () => {
    const t = await signUnsubscribe(SECRET, 'tim@example.com');
    expect(await verifyUnsubscribe(SECRET, 'tim@example.com', t)).toBe(true);
  });

  it('a token for one address cannot unsubscribe another', async () => {
    // The attack this closes: editing ?e= in a link you received to remove
    // somebody else from the list.
    const t = await signUnsubscribe(SECRET, 'tim@example.com');
    expect(await verifyUnsubscribe(SECRET, 'someone@else.com', t)).toBe(false);
  });

  it('rejects a forged, empty, or malformed token without throwing', async () => {
    expect(await verifyUnsubscribe(SECRET, 'tim@example.com', 'AAAA')).toBe(false);
    expect(await verifyUnsubscribe(SECRET, 'tim@example.com', '')).toBe(false);
    expect(await verifyUnsubscribe(SECRET, 'tim@example.com', '!!!not base64!!!')).toBe(false);
    expect(await verifyUnsubscribe(SECRET, '', 'anything')).toBe(false);
  });

  it('does not expire — an unsubscribe link must work months later', async () => {
    // Encoded as a property of the signature: there is no timestamp in the
    // payload, so there is nothing that can age out. A dead unsubscribe link
    // becomes a spam complaint.
    const t = await signUnsubscribe(SECRET, 'tim@example.com');
    expect(t).not.toMatch(/\d{10}/);
    expect(await verifyUnsubscribe(SECRET, 'tim@example.com', t)).toBe(true);
  });

  it('a different secret does not validate', async () => {
    const t = await signUnsubscribe(SECRET, 'tim@example.com');
    expect(await verifyUnsubscribe('other-secret', 'tim@example.com', t)).toBe(false);
  });
});

describe('the signup opt-in', () => {
  const src = readFileSync(
    new URL('../../functions/api/auth/signup.ts', import.meta.url), 'utf8');
  const page = readFileSync(
    new URL('../../src/pages/signup.astro', import.meta.url), 'utf8');

  it('subscribes ONLY on an explicit true, never on a missing or truthy-ish field', () => {
    // `if (body.newsletter)` would opt in on the string "false", on "0", on
    // any stray value a client sent. Creating an account is not asking for
    // marketing, so the flag has to arrive as the boolean true.
    expect(src).toMatch(/body\.newsletter === true/);
  });

  it('cannot fail the signup — the account is already written by then', () => {
    const call = src.slice(src.indexOf('body.newsletter === true'));
    expect(call.slice(0, 200)).toMatch(/waitUntil\(\s*subscribeToNewsletter/);
  });

  it('ships the checkbox UNCHECKED', () => {
    // A pre-ticked marketing box is not consent — prohibited outright under
    // GDPR, and it poisons the list either way, because people who never chose
    // to be on it are the ones who report mail as spam.
    const box = page.slice(page.indexOf('name="newsletter"') - 400, page.indexOf('name="newsletter"') + 200);
    expect(box).not.toMatch(/\bchecked\b/);
  });

  it('sends the flag to the endpoint', () => {
    expect(page).toMatch(/newsletter,/);
    expect(page).toMatch(/fd\.get\('newsletter'\) === 'on'/);
  });
});
