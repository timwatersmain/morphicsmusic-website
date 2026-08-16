// Pure helpers for the post-signup -> login handoff. Split out from
// signup.astro and login.astro so the decision logic (what URL to redirect
// to, what to show when we land) can be unit tested without a DOM or a
// live Turnstile widget.
//
// Why this handoff exists: /api/auth/signup deliberately never sets a
// session cookie, even on real success (see functions/api/auth/signup.ts).
// An earlier version of signup.astro tried to paper over that by
// immediately POSTing to /api/auth/password-login with the credentials
// just typed — but that call carries no Turnstile token (signup's token
// was already consumed, and Turnstile tokens are single-use), so on a site
// with Turnstile configured that follow-up call was rejected 100% of the
// time in production. The fix is a real redirect to /login, which renders
// its own fresh Turnstile widget.

/**
 * Build the URL to send the browser to right after a successful signup.
 * Carries the just-created username so /login can prefill the identifier
 * field, and preserves any `redirect` the visitor arrived with so they
 * still land where they were going after they type their password.
 * @param {string} username
 * @param {string} currentSearch - e.g. location.search
 * @returns {string}
 */
export function postSignupRedirect(username, currentSearch) {
  const params = new URLSearchParams(currentSearch || '');
  const redirect = params.get('redirect');
  const dest = new URLSearchParams();
  dest.set('created', '1');
  dest.set('u', username);
  if (redirect) dest.set('redirect', redirect);
  return `/login?${dest.toString()}`;
}

/**
 * Read the "you just created an account" state out of /login's query
 * string. Returns a username capped to the signup form's own max length
 * (24 chars) as a defense-in-depth trim -- the real safety property is
 * that callers must render it with textContent (or equivalent escaping),
 * never innerHTML, since it is attacker-controllable URL input.
 * @param {string} search - e.g. location.search
 * @returns {{ created: boolean, username: string | null }}
 */
export function parseCreatedState(search) {
  const params = new URLSearchParams(search || '');
  const created = params.get('created') === '1';
  const rawUsername = params.get('u') || '';
  const username = rawUsername.slice(0, 24) || null;
  return { created, username: created ? username : null };
}
