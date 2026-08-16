import { describe, it, expect } from 'vitest';
import { decideAuthState, decideAuthStateFromFetch } from '../../src/scripts/auth-state.js';

// This pins the actual regression: BUG 1 was the nav asserting "Sign in"
// on rate limits, network errors, and other non-answers from /api/auth/me.
// Only a definitive 200 { email: null } may say signed-out.

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe('decideAuthState', () => {
  it('200 with an email -> signed-in', async () => {
    const result = await decideAuthState(jsonResponse({ email: 'fan@example.com' }));
    expect(result).toEqual({ state: 'signed-in', email: 'fan@example.com' });
  });

  it('200 with email: null -> signed-out', async () => {
    const result = await decideAuthState(jsonResponse({ email: null }));
    expect(result).toEqual({ state: 'signed-out', email: null });
  });

  it('429 rate limit -> unknown, NOT signed-out', async () => {
    const result = await decideAuthState(jsonResponse({ error: 'rate limited' }, false, 429));
    expect(result.state).toBe('unknown');
  });

  it('non-OK status generally -> unknown', async () => {
    const result = await decideAuthState(jsonResponse({}, false, 500));
    expect(result.state).toBe('unknown');
  });

  it('malformed JSON body -> unknown', async () => {
    const badResponse = {
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    } as unknown as Response;
    const result = await decideAuthState(badResponse);
    expect(result.state).toBe('unknown');
  });

  it('unexpected body shape (missing email field) -> unknown', async () => {
    const result = await decideAuthState(jsonResponse({ ok: true }));
    expect(result.state).toBe('unknown');
  });

  it('null response -> unknown', async () => {
    const result = await decideAuthState(null as unknown as Response);
    expect(result.state).toBe('unknown');
  });
});

describe('decideAuthStateFromFetch', () => {
  it('network rejection -> unknown', async () => {
    const rejected = Promise.reject(new TypeError('Failed to fetch'));
    const result = await decideAuthStateFromFetch(rejected);
    expect(result.state).toBe('unknown');
  });

  it('resolves through to the same decision as decideAuthState', async () => {
    const resolved = Promise.resolve(jsonResponse({ email: 'fan@example.com' }));
    const result = await decideAuthStateFromFetch(resolved);
    expect(result).toEqual({ state: 'signed-in', email: 'fan@example.com' });
  });
});
