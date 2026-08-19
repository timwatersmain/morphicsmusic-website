import { describe, it, expect } from 'vitest';
import {
  INTENTS, INTENT_ORDER, isIntent, routeFor, validateSubmission, spamScore,
  formatSubmission, isValidEmail, SPAM_REFUSE_AT, MIN_FILL_SECONDS,
  DEFAULT_CONTACT_INBOX,
} from '../../functions/_lib/contact';

describe('intents', () => {
  it('every ordered intent exists, and every intent is ordered', () => {
    expect(INTENT_ORDER.sort()).toEqual(Object.keys(INTENTS).sort());
  });

  it('every intent asks for an email, because every intent needs a reply path', () => {
    for (const key of INTENT_ORDER) {
      const email = INTENTS[key].fields.find(f => f.name === 'email');
      expect(email, `${key} has no email field`).toBeTruthy();
      expect(email!.required).toBe(true);
    }
  });

  it('every intent states when the sender will hear back', () => {
    for (const key of INTENT_ORDER) expect(INTENTS[key].replyWithin.trim()).not.toBe('');
  });

  it('rejects anything that is not a known intent', () => {
    expect(isIntent('book')).toBe(true);
    expect(isIntent('nope')).toBe(false);
    expect(isIntent(undefined)).toBe(false);
    // A prototype key must not read as an intent.
    expect(isIntent('toString')).toBe(false);
    expect(isIntent('constructor')).toBe(false);
  });
});

describe('routeFor', () => {
  it('falls back to one inbox when nothing is configured', () => {
    for (const key of INTENT_ORDER) expect(routeFor(key, {})).toBe(DEFAULT_CONTACT_INBOX);
  });

  it('sends booking somewhere else the moment a booking inbox exists', () => {
    const env = { CONTACT_TO_BOOKING: 'booking@example.com' };
    expect(routeFor('book', env)).toBe('booking@example.com');
    // ...without dragging fan mail along with it.
    expect(routeFor('hello', env)).toBe(DEFAULT_CONTACT_INBOX);
  });

  it('a general override moves everything that has no inbox of its own', () => {
    const env = { CONTACT_TO_GENERAL: 'all@example.com', CONTACT_TO_PRESS: 'press@example.com' };
    expect(routeFor('press', env)).toBe('press@example.com');
    expect(routeFor('license', env)).toBe('all@example.com');
    expect(routeFor('hello', env)).toBe('all@example.com');
  });
});

describe('validateSubmission', () => {
  const goodBooking = {
    name: 'Alex Buyer', email: 'alex@venue.com', organization: 'The Venue',
    city: 'Leeds', event_date: 'any weekend in March',
  };

  it('accepts a complete booking enquiry', () => {
    const r = validateSubmission('book', goodBooking);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual({});
    expect(r.clean.organization).toBe('The Venue');
  });

  it('names every missing required field at once, not one per round trip', () => {
    const r = validateSubmission('book', { name: 'Alex' });
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors).sort()).toEqual(['city', 'email', 'event_date', 'organization']);
  });

  it('optional fields are genuinely optional', () => {
    const r = validateSubmission('book', goodBooking);
    expect(r.ok).toBe(true);
    expect(r.clean.budget).toBeUndefined();
  });

  it('trims, and treats whitespace-only as missing', () => {
    const r = validateSubmission('hello', { name: '  Sam  ', email: 'sam@x.co', message: '   ' });
    expect(r.clean.name).toBe('Sam');
    expect(r.errors.message).toBeTruthy();
  });

  it('drops unknown keys instead of letting them reach the email body', () => {
    const r = validateSubmission('hello', {
      name: 'Sam', email: 'sam@x.co', message: 'hi',
      evil: '<script>alert(1)</script>', intent: 'book',
    });
    expect(r.ok).toBe(true);
    expect(r.clean).not.toHaveProperty('evil');
    expect(r.clean).not.toHaveProperty('intent');
  });

  it('refuses an over-long value rather than silently truncating what someone wrote', () => {
    const r = validateSubmission('hello', { name: 'Sam', email: 'sam@x.co', message: 'x'.repeat(5000) });
    expect(r.ok).toBe(false);
    expect(r.errors.message).toMatch(/too long/i);
  });

  it('only validates the chosen intent’s fields', () => {
    // `usage` is required for licensing and unknown to a plain hello.
    expect(validateSubmission('hello', { name: 'S', email: 's@x.co', message: 'hi' }).ok).toBe(true);
    expect(validateSubmission('license', { name: 'S', email: 's@x.co' }).ok).toBe(false);
  });
});

describe('isValidEmail', () => {
  it('accepts ordinary and awkward-but-real addresses', () => {
    for (const e of ['a@b.co', 'first.last+tag@sub.domain.org', 'booking@venue-name.co.uk']) {
      expect(isValidEmail(e), e).toBe(true);
    }
  });

  it('rejects obvious nonsense only', () => {
    for (const e of ['', 'nope', 'a@b', 'a b@c.com', '@b.com', 'a@.com']) {
      expect(isValidEmail(e), e).toBe(false);
    }
  });
});

describe('spamScore', () => {
  it('a real submission scores zero', () => {
    expect(spamScore({ honeypot: '', elapsedSeconds: 45 })).toBe(0);
  });

  it('a filled honeypot alone is enough to refuse', () => {
    expect(spamScore({ honeypot: 'http://spam', elapsedSeconds: 60 })).toBeGreaterThanOrEqual(SPAM_REFUSE_AT);
  });

  it('an implausibly fast fill is suspicious but NOT refused on its own', () => {
    const score = spamScore({ honeypot: '', elapsedSeconds: MIN_FILL_SECONDS - 1 });
    expect(score).toBeGreaterThan(0);
    // A fast human — pasting a prepared message — must still get through.
    expect(score).toBeLessThan(SPAM_REFUSE_AT);
  });

  it('a missing or nonsense timer never counts against the sender', () => {
    expect(spamScore({})).toBe(0);
    expect(spamScore({ elapsedSeconds: NaN })).toBe(0);
    expect(spamScore({ elapsedSeconds: -5 })).toBe(0);
  });
});

describe('formatSubmission', () => {
  it('lists answered fields in form order, with labels', () => {
    const { clean } = validateSubmission('book', {
      name: 'Alex', email: 'a@v.com', organization: 'Venue', city: 'Leeds',
      event_date: 'March', budget: '£500',
    });
    const text = formatSubmission('book', clean);
    expect(text.split('\n')[0]).toBe('Your name: Alex');
    expect(text).toContain('Offer or budget range: £500');
    // Nothing empty, so the reader is not scrolling past blank labels.
    expect(text).not.toMatch(/:\s*$/m);
  });
});
