import { describe, it, expect } from 'vitest';
import { postSignupRedirect, parseCreatedState } from '../../src/scripts/auth-flow.js';

// Pins the security-review fix: signup.astro no longer POSTs a follow-up
// /api/auth/password-login call (that call had no valid Turnstile token —
// signup's own token is single-use and already spent, so on a
// Turnstile-protected site it was rejected on every real signup). Instead
// it redirects to /login, which renders its own fresh widget. These tests
// cover the pure redirect-building and query-parsing logic that replaced
// the login call, without needing a DOM or a live Turnstile widget.

describe('postSignupRedirect', () => {
  it('builds a /login URL carrying created=1 and the username', () => {
    const url = postSignupRedirect('newfan', '');
    expect(url).toBe('/login?created=1&u=newfan');
  });

  it('preserves an existing redirect param from the signup page', () => {
    const url = postSignupRedirect('newfan', '?redirect=%2Flibrary');
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('created')).toBe('1');
    expect(params.get('u')).toBe('newfan');
    expect(params.get('redirect')).toBe('/library');
  });

  it('omits redirect when none was present', () => {
    const url = postSignupRedirect('newfan', '?foo=bar');
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.has('redirect')).toBe(false);
  });
});

describe('parseCreatedState', () => {
  it('reads created + username off the query string', () => {
    const result = parseCreatedState('?created=1&u=newfan');
    expect(result).toEqual({ created: true, username: 'newfan' });
  });

  it('created absent -> not created, username ignored even if present', () => {
    const result = parseCreatedState('?u=newfan');
    expect(result).toEqual({ created: false, username: null });
  });

  it('created=1 with no username -> created true, username null', () => {
    const result = parseCreatedState('?created=1');
    expect(result).toEqual({ created: true, username: null });
  });

  it('caps an oversized username (attacker-controlled URL input) to 24 chars', () => {
    const huge = 'a'.repeat(500);
    const result = parseCreatedState(`?created=1&u=${huge}`);
    expect(result.created).toBe(true);
    expect(result.username).toHaveLength(24);
  });

  it('does not choke on markup-shaped input — caller is responsible for textContent rendering', () => {
    // This function does no HTML escaping itself (that's the caller's job,
    // via textContent) — it just extracts and length-caps the value. Confirm
    // it passes the raw string through unmangled so a textContent consumer
    // renders it inert, rather than this function silently interpreting it.
    const result = parseCreatedState('?created=1&u=' + encodeURIComponent('<img src=x>'));
    expect(result.username).toBe('<img src=x>'.slice(0, 24));
  });
});
