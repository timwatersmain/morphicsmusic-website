// The booking/contact portal's rules, with no I/O so they can be unit
// tested and so the page and the endpoint cannot disagree about them.
//
// One route, four intents. A talent buyer and a fan need completely
// different forms, and showing both to everyone loses both — so the page
// asks "what brings you here?" first and reveals only the matching fields.
// The same INTENTS table drives the markup, the server-side validation and
// the routing, so a field added in one place cannot go unvalidated in
// another.

export type IntentKey = 'book' | 'license' | 'press' | 'hello';

export interface Field {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'tel' | 'date' | 'number' | 'textarea';
  required?: boolean;
  placeholder?: string;
  maxLength?: number;
}

export interface Intent {
  key: IntentKey;
  /** The button a visitor picks. Written from their side, not the system's. */
  label: string;
  blurb: string;
  /** Subject prefix, so a booking never has to be dug out of fan mail. */
  subject: string;
  /** What the sender is told to expect. An unanswered form is worse than no form. */
  replyWithin: string;
  fields: Field[];
}

const EMAIL: Field = { name: 'email', label: 'Email', type: 'email', required: true, maxLength: 200 };
const NAME: Field = { name: 'name', label: 'Your name', required: true, maxLength: 120 };

export const INTENTS: Record<IntentKey, Intent> = {
  book: {
    key: 'book',
    label: 'Book a show',
    blurb: 'Venues, promoters and festivals.',
    subject: 'BOOKING',
    replyWithin: 'within 2 working days',
    fields: [
      NAME, EMAIL,
      { name: 'organization', label: 'Venue, promoter or festival', required: true, maxLength: 160 },
      { name: 'role', label: 'Your role', maxLength: 120 },
      { name: 'phone', label: 'Phone', type: 'tel', maxLength: 60 },
      { name: 'city', label: 'City', required: true, maxLength: 120 },
      { name: 'event_date', label: 'Date or date range', required: true, maxLength: 120,
        placeholder: 'e.g. 14 March, or any weekend in March' },
      { name: 'capacity', label: 'Room capacity', type: 'number', maxLength: 12 },
      { name: 'budget', label: 'Offer or budget range', maxLength: 120 },
      { name: 'message', label: 'Anything else', type: 'textarea', maxLength: 4000 },
    ],
  },
  license: {
    key: 'license',
    label: 'License music',
    blurb: 'Film, games, ads and sync.',
    subject: 'LICENSING',
    replyWithin: 'within 3 working days',
    fields: [
      NAME, EMAIL,
      { name: 'organization', label: 'Company', maxLength: 160 },
      { name: 'project_type', label: 'Project type', required: true, maxLength: 160,
        placeholder: 'e.g. short film, game trailer, brand spot' },
      { name: 'usage', label: 'How the music would be used', required: true, maxLength: 400 },
      { name: 'territory', label: 'Territory', maxLength: 120, placeholder: 'e.g. worldwide, UK only' },
      { name: 'term', label: 'Term', maxLength: 120, placeholder: 'e.g. 2 years, perpetuity' },
      { name: 'timeline', label: 'Timeline', maxLength: 120 },
      { name: 'budget', label: 'Budget', maxLength: 120 },
      { name: 'message', label: 'Anything else', type: 'textarea', maxLength: 4000 },
    ],
  },
  press: {
    key: 'press',
    label: 'Press',
    blurb: 'Interviews, features and premieres.',
    subject: 'PRESS',
    replyWithin: 'within 2 working days',
    fields: [
      NAME, EMAIL,
      { name: 'organization', label: 'Outlet', required: true, maxLength: 160 },
      { name: 'request_type', label: 'What you need', required: true, maxLength: 160,
        placeholder: 'e.g. interview, premiere, review copy' },
      { name: 'deadline', label: 'Deadline', maxLength: 120 },
      { name: 'message', label: 'Details', type: 'textarea', maxLength: 4000 },
    ],
  },
  hello: {
    key: 'hello',
    label: 'Just saying hi',
    blurb: 'Anything else at all.',
    subject: 'HELLO',
    replyWithin: 'when I can — I read everything',
    fields: [
      NAME, EMAIL,
      { name: 'message', label: 'Message', type: 'textarea', required: true, maxLength: 4000 },
    ],
  },
};

export const INTENT_ORDER: IntentKey[] = ['book', 'license', 'press', 'hello'];

export function isIntent(v: unknown): v is IntentKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(INTENTS, v);
}

/**
 * Where each intent is delivered. Every intent resolves to its own env var
 * so booking can be split off the moment a second inbox exists — today they
 * all fall back to one address, and that fallback is a config decision
 * rather than something buried in the send call.
 */
export interface ContactRouting {
  CONTACT_TO_BOOKING?: string;
  CONTACT_TO_LICENSING?: string;
  CONTACT_TO_PRESS?: string;
  CONTACT_TO_GENERAL?: string;
}

export const DEFAULT_CONTACT_INBOX = 'morphicsmusic@gmail.com';

export function routeFor(intent: IntentKey, env: ContactRouting): string {
  const fallback = env.CONTACT_TO_GENERAL || DEFAULT_CONTACT_INBOX;
  switch (intent) {
    case 'book': return env.CONTACT_TO_BOOKING || fallback;
    case 'license': return env.CONTACT_TO_LICENSING || fallback;
    case 'press': return env.CONTACT_TO_PRESS || fallback;
    default: return fallback;
  }
}

// Deliberately loose: this rejects obvious nonsense and nothing else. A
// stricter pattern's failure mode is silently refusing a real talent
// buyer's unusual address, which costs far more than a bounced email.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export function isValidEmail(v: string): boolean {
  return v.length <= 200 && EMAIL_RE.test(v);
}

export interface ValidationResult {
  ok: boolean;
  /** Field name -> what to fix. Empty when ok. */
  errors: Record<string, string>;
  /** Trimmed, length-capped values for the intent's known fields only. */
  clean: Record<string, string>;
}

/**
 * Validate a submission against its intent's own field list. Unknown keys
 * are DROPPED rather than rejected: a stray field is not worth failing a
 * genuine enquiry over, but it must never reach the email body either.
 */
export function validateSubmission(intent: IntentKey, body: Record<string, unknown>): ValidationResult {
  const errors: Record<string, string> = {};
  const clean: Record<string, string> = {};

  for (const field of INTENTS[intent].fields) {
    const raw = body[field.name];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      if (field.required) errors[field.name] = `${field.label} is required.`;
      continue;
    }
    const max = field.maxLength ?? 500;
    if (value.length > max) {
      errors[field.name] = `${field.label} is too long (max ${max} characters).`;
      continue;
    }
    if (field.type === 'email' && !isValidEmail(value)) {
      errors[field.name] = 'That email address does not look right.';
      continue;
    }
    clean[field.name] = value;
  }

  return { ok: Object.keys(errors).length === 0, errors, clean };
}

/** Minimum seconds between the form rendering and being submitted. */
export const MIN_FILL_SECONDS = 3;

export interface SpamSignals {
  /** Hidden field a human never sees and never fills. */
  honeypot?: unknown;
  /** Seconds the visitor spent on the form, from a timestamp the page stamps. */
  elapsedSeconds?: number;
}

/**
 * A score, not a verdict — the caller decides the threshold.
 *
 * Deliberately no captcha in front of a talent buyer's first contact: the
 * spec is right that it costs more in lost enquiries than it saves. A
 * honeypot and a fill-time floor catch naive bots for free and are
 * invisible to humans; anything that scores high is flagged for review, not
 * silently discarded, because a false positive here is a lost booking.
 */
export function spamScore(signals: SpamSignals): number {
  let score = 0;
  if (typeof signals.honeypot === 'string' && signals.honeypot.trim() !== '') score += 10;
  const elapsed = Number(signals.elapsedSeconds);
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_FILL_SECONDS) score += 5;
  return score;
}

/** At or above this, the submission is refused outright. */
export const SPAM_REFUSE_AT = 10;

/** Plain-text email body — one labelled line per answered field, in form order. */
export function formatSubmission(intent: IntentKey, clean: Record<string, string>): string {
  const lines: string[] = [];
  for (const field of INTENTS[intent].fields) {
    const value = clean[field.name];
    if (value) lines.push(`${field.label}: ${value}`);
  }
  return lines.join('\n');
}
