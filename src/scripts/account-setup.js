// Pure helpers for the /account "set up sign-in details" page — split out
// so the validation and error-mapping logic (the parts most likely to drift
// from the server) can be unit tested without a DOM.
//
// The rules mirrored here MUST match functions/api/auth/set-password.ts:
//   USERNAME_RE = /^[a-z0-9_-]{3,24}$/, MIN_PASSWORD = 10.
// This copy is fast client feedback only — the server re-validates
// everything and is the only source of truth; a mismatch here can only
// cause an over-eager or under-eager client error, never a security gap.

export const USERNAME_RE = /^[a-z0-9_-]{3,24}$/;
export const MIN_PASSWORD = 10;

/**
 * Client-side validation matching the server, for fast feedback only.
 * @param {{ username: string, password: string, confirm: string }} fields
 * @returns {string | null} an error message, or null if the fields pass.
 */
export function clientValidate({ username, password, confirm }) {
  if (!USERNAME_RE.test(username)) {
    return 'Username must be 3-24 characters: lowercase letters, numbers, underscore, or hyphen.';
  }
  if (password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters.`;
  }
  if (password !== confirm) {
    return 'Passwords don’t match.';
  }
  return null;
}

// Maps the distinct failure shapes /api/auth/set-password can return to
// specific, actionable copy. This page is always behind a live session, so
// (unlike signup/login) there is no enumeration risk in being specific here
// — see functions/api/auth/set-password.ts for the exact strings/statuses.
/**
 * @param {number} status
 * @param {{ error?: string }} data
 * @returns {string}
 */
export function describeSetPasswordError(status, data) {
  const err = (data && data.error) || '';
  if (status === 401) {
    if (err === 'current password required') {
      return 'Enter your current password to make this change.';
    }
    if (err === 'current password incorrect') {
      return 'That current password is incorrect.';
    }
    return 'Session expired — sign in again.';
  }
  if (status === 400) {
    if (err === 'that username is not available') {
      return 'That username is taken or reserved — pick another.';
    }
    if (err.startsWith('username must be')) {
      return 'Username must be 3-24 characters: lowercase letters, numbers, underscore, or hyphen.';
    }
    if (err.startsWith('password must be')) {
      return `Password must be at least ${MIN_PASSWORD} characters.`;
    }
    if (err === 'passwords do not match') {
      return 'Passwords don’t match.';
    }
  }
  if (status === 429) {
    return 'Too many attempts — wait a bit and try again.';
  }
  return 'Could not save your sign-in details. Try again.';
}
