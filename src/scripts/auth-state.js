// Pure decision logic for "what should the account control show" given a
// response from /api/auth/me. Split out from TopNav.astro and login.astro so
// the decision — the part that was actually wrong — can be unit tested
// without a DOM.
//
// /api/auth/me only ever answers definitively in one shape: HTTP 200 with
// { email: string | null }. Anything else (rate limit, network failure,
// malformed body) is NOT evidence the user is signed out — it just means we
// don't know, and the UI must not assert "Sign in" on a guess.

/** @typedef {'signed-in' | 'signed-out' | 'unknown'} AuthState */

/**
 * @param {Response} response
 * @returns {Promise<{ state: AuthState, email: string | null }>}
 */
export async function decideAuthState(response) {
  if (!response || !response.ok) {
    return { state: 'unknown', email: null };
  }
  let data;
  try {
    data = await response.json();
  } catch {
    // Malformed/non-JSON body — the server didn't give us a real answer.
    return { state: 'unknown', email: null };
  }
  if (data && typeof data.email === 'string' && data.email) {
    return { state: 'signed-in', email: data.email };
  }
  if (data && data.email === null) {
    return { state: 'signed-out', email: null };
  }
  // Any other shape (missing field, unexpected type) is not a definitive
  // signed-out answer either.
  return { state: 'unknown', email: null };
}

/**
 * Same decision, but from a fetch Promise so callers can pass a rejected
 * fetch (network error/offline) straight through and still get 'unknown'.
 * @param {Promise<Response>} fetchPromise
 * @returns {Promise<{ state: AuthState, email: string | null }>}
 */
export async function decideAuthStateFromFetch(fetchPromise) {
  let response;
  try {
    response = await fetchPromise;
  } catch {
    return { state: 'unknown', email: null };
  }
  return decideAuthState(response);
}
