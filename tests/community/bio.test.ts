import { describe, it, expect } from 'vitest';
import { sanitizeBio, isValidBio, MAX_BIO_LENGTH } from '../../functions/_lib/community/bio';

describe('sanitizeBio', () => {
  it('keeps ordinary text as written', () => {
    expect(sanitizeBio('Berlin. Modular and field recordings.'))
      .toBe('Berlin. Modular and field recordings.');
  });

  it('treats empty, whitespace-only and null as "no bio" rather than an error', () => {
    // Clearing a bio is an edit a fan is allowed to make, so all of these
    // must normalise to null and pass isValidBio, never reject.
    for (const raw of ['', '   ', '\n\n', null, undefined]) {
      const bio = sanitizeBio(raw);
      expect(bio).toBeNull();
      expect(isValidBio(bio)).toBe(true);
    }
  });

  it('strips control characters but keeps newlines', () => {
    const bio = sanitizeBio('line one\u0000\u0007\nline two');
    expect(bio).toBe('line one\nline two');
  });

  it('strips zero-width and bidi-override characters used to hide or flip text', () => {
    // U+200B zero width space, U+202E right-to-left override, U+FEFF BOM.
    expect(sanitizeBio('mor\u200bphics\u202e\ufeff')).toBe('morphics');
  });

  it('collapses a CRLF to a single newline rather than two', () => {
    expect(sanitizeBio('one\r\ntwo')).toBe('one\ntwo');
  });

  it('collapses runs of blank lines so nobody can push their name off-screen', () => {
    expect(sanitizeBio('top\n\n\n\n\n\nbottom')).toBe('top\n\nbottom');
  });

  it('trims trailing spaces per line and around the whole bio', () => {
    expect(sanitizeBio('  hello   \nworld   ')).toBe('hello\nworld');
  });
});

describe('isValidBio', () => {
  it('accepts a bio exactly at the cap and rejects one past it', () => {
    expect(isValidBio('a'.repeat(MAX_BIO_LENGTH))).toBe(true);
    expect(isValidBio('a'.repeat(MAX_BIO_LENGTH + 1))).toBe(false);
  });

  it('counts code points, not UTF-16 units, so an emoji costs one character', () => {
    // Each of these is a surrogate pair: .length would say 2 per emoji and
    // reject a bio the fan sees as being exactly at the limit.
    const bio = 'x'.repeat(MAX_BIO_LENGTH - 1) + '\u{1F41B}';
    expect([...bio].length).toBe(MAX_BIO_LENGTH);
    expect(isValidBio(bio)).toBe(true);
  });

  it('always accepts null', () => {
    expect(isValidBio(null)).toBe(true);
  });

  it('cannot be beaten by padding a long bio with invisible characters', () => {
    // The length check runs on the SANITISED text, so zero-width padding
    // neither inflates nor smuggles anything past the cap.
    const sneaky = 'a'.repeat(MAX_BIO_LENGTH) + '\u200b'.repeat(50);
    expect(isValidBio(sanitizeBio(sneaky))).toBe(true);
    const over = 'a'.repeat(MAX_BIO_LENGTH + 1) + '\u200b';
    expect(isValidBio(sanitizeBio(over))).toBe(false);
  });
});
