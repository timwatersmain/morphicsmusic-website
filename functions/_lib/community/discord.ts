// The bot gate and the pure pieces of the Discord link handshake.
//
// Machine auth, not session auth: every /api/community endpoint identifies
// a HUMAN via a signed session cookie, and /api/admin/* additionally checks
// that human against ADMIN_EMAILS. The Discord bot is neither — it is a
// daemon in a container with no browser and no session, so it presents a
// shared secret in a header instead. That is why these endpoints live under
// /api/discord/ rather than being bolted onto the admin surface.

export interface DiscordBotEnv {
  GATES: D1Database;
  /** Shared secret, set with `wrangler pages secret put DISCORD_BOT_SECRET`. */
  DISCORD_BOT_SECRET?: string;
}

export const BOT_TOKEN_HEADER = 'X-Morphics-Bot-Token';

/**
 * Constant-time string comparison.
 *
 * `a === b` on secrets leaks their content through timing: it returns at the
 * first differing byte, so an attacker can recover the secret one character
 * at a time by measuring which guesses take fractionally longer. This always
 * walks the full length. Lengths are compared first and separately — length
 * is not secret, and short-circuiting on it avoids indexing past the end.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True when the request carries the bot's shared secret.
 *
 * A MISSING or empty DISCORD_BOT_SECRET denies everything. The dangerous
 * alternative is an env-var typo silently turning the gate off and leaving
 * an unauthenticated EP-granting endpoint on the public internet; failing
 * closed makes that outage loud instead of invisible.
 */
export function isBot(request: Request, env: DiscordBotEnv): boolean {
  const expected = (env.DISCORD_BOT_SECRET || '').trim();
  if (!expected) return false;
  const got = (request.headers.get(BOT_TOKEN_HEADER) || '').trim();
  if (!got) return false;
  return timingSafeEqual(got, expected);
}

/** Same reasoning as adminNotFound: never confirm the endpoint exists. */
export function botNotFound(): Response {
  return new Response('Not found', { status: 404 });
}

// Unambiguous alphabet: no O/0, I/1/L, U/V. A fan reads this code off
// Discord and types it into a browser, and every excluded character is one
// people reliably mistype in that hop.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';
export const CODE_LENGTH = 8;
export const CODE_TTL_SECONDS = 15 * 60;

/**
 * A random link code, from crypto — NOT Math.random, which is seeded
 * predictably enough that codes could be guessed from one another. Rejection
 * sampling on the byte keeps the alphabet uniform: a plain `byte % 29` would
 * make the first 24 characters meaningfully likelier than the last 5.
 */
export function generateCode(randomBytes: (n: number) => Uint8Array = cryptoBytes): string {
  let out = '';
  while (out.length < CODE_LENGTH) {
    const bytes = randomBytes(CODE_LENGTH);
    for (const b of bytes) {
      if (b >= 256 - (256 % CODE_ALPHABET.length)) continue;
      out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

function cryptoBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * Normalise a code as typed by a human: trim, uppercase, drop the spaces and
 * dashes people insert when copying. Returns '' for anything that still
 * isn't a well-formed code, so callers reject it before it reaches the
 * database as a query.
 */
export function normaliseCode(input: unknown): string {
  const cleaned = String(input ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
  if (cleaned.length !== CODE_LENGTH) return '';
  for (const ch of cleaned) if (!CODE_ALPHABET.includes(ch)) return '';
  return cleaned;
}

/**
 * The largest EP delta a single award call may apply.
 *
 * The bot already enforces its own per-source daily and weekly caps
 * (services/storage/xp_db.py) and sends only net deltas, so this is not the
 * pacing mechanism — it is the blast radius if the bot is ever wrong, or if
 * the shared secret leaks. Set above the bot's WEEKLY_CAP of 60 so a
 * legitimate batched award is never silently clipped.
 */
export const MAX_AWARD_DELTA = 100;

/** Clamp an award to something sane, or null if it is not a usable number. */
export function clampAward(amount: unknown): number | null {
  const n = Number(amount);
  if (!Number.isFinite(n) || n === 0) return null;
  const rounded = Math.trunc(n);
  if (rounded === 0) return null;
  return Math.max(-MAX_AWARD_DELTA, Math.min(MAX_AWARD_DELTA, rounded));
}
