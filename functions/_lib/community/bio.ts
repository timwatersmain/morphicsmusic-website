// Bio validation + sanitising. Pure, no D1 - the one place that decides what
// a fan's bio may contain, so the write path (update.ts) and the tests agree
// by construction rather than by two hand-kept copies of the same rules.
//
// Deliberately NOT a DB CHECK constraint: the length is a copy decision that
// will be tuned, and every tune of a CHECK on fan_profiles costs a full table
// rebuild (see migrations 0007/0009/0010). See 0011's header comment.

/** Characters, not bytes - a bio is counted the way the fan sees it. */
export const MAX_BIO_LENGTH = 300;

/** Blank lines beyond this collapse, so nobody can push their name off-screen. */
const MAX_CONSECUTIVE_NEWLINES = 2;

/**
 * Codepoints a bio may not contain: C0/C1 control characters, and the
 * zero-width / bidi-override range used to hide text or flip its direction
 * inside an otherwise innocent-looking line. U+000A (newline) is the one
 * formatting character that survives.
 *
 * Written as a numeric test rather than a regex character class on purpose -
 * a class of literal control characters is invisible in source, so nobody can
 * review or grep it, and a stray copy-paste silently changes what it strips.
 */
function isStripped(cp: number): boolean {
  if (cp === 0x0a) return false;
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

/**
 * Normalises a submitted bio into what actually gets stored, or returns null
 * for "no bio" (empty string included - clearing a bio is a legitimate edit,
 * not an error, so it must not be rejected as invalid).
 *
 * Rejection is the caller's job on exactly one condition: too long. Everything
 * else here is normalisation, because silently fixing whitespace is kinder
 * than a 400 that makes a fan hunt for the offending character.
 */
export function sanitizeBio(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  // Line endings first, so a CRLF becomes ONE newline rather than surviving as
  // a carriage return that the strip below would delete, silently welding two
  // lines together.
  const stripped = [...String(raw).replace(/\r\n?/g, '\n')]
    .filter(ch => !isStripped(ch.codePointAt(0) as number))
    .join('')
    // Trailing spaces on a line are invisible noise; leading ones are the
    // fan's own indentation and are kept.
    .replace(/[ \t]+$/gm, '')
    .replace(
      new RegExp(`\\n{${MAX_CONSECUTIVE_NEWLINES + 1},}`, 'g'),
      '\n'.repeat(MAX_CONSECUTIVE_NEWLINES),
    )
    .trim();
  return stripped.length ? stripped : null;
}

/**
 * True when a sanitised bio is short enough to store. NULL always passes.
 * Counts by code point, not UTF-16 unit, so an emoji costs a fan one
 * character rather than two.
 */
export function isValidBio(bio: string | null): boolean {
  return bio === null || [...bio].length <= MAX_BIO_LENGTH;
}
