// Password hashing for username/password login. This sits ALONGSIDE the
// magic-link system in auth.ts, not instead of it — magic links keep working
// as the forgot-password path.
//
// Scheme: HMAC-SHA256(password, PASSWORD_PEPPER) → PBKDF2-HMAC-SHA256 over
// that, with a random 16-byte per-user salt and a configurable iteration
// count. The pepper is a server-only secret that never touches the database,
// so a KV/D1-only leak (with every salt + hash) yields nothing crackable
// without also compromising the Worker's env — a different, harder breach.
//
// PASSWORD_PEPPER is a SEPARATE secret from AUTH_SECRET on purpose: rotating
// session-signing keys (e.g. after a suspected cookie leak) must not also
// invalidate every stored password.

const DEFAULT_ITERATIONS = 12000;
const SALT_BYTES = 16;
const HASH_VERSION = 1;

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

export interface PasswordEnv {
  PASSWORD_PEPPER: string;
  PASSWORD_KDF_ITERATIONS?: string;
}

// Fail closed: a missing pepper must throw, never silently fall back to an
// unpeppered hash or to AUTH_SECRET. A quiet downgrade would produce hashes
// that look valid and are worthless — worse than a loud crash, because
// nobody would notice until the leak.
function requirePepper(env: PasswordEnv): string {
  const pepper = env.PASSWORD_PEPPER;
  if (!pepper || typeof pepper !== 'string' || pepper.length < 16) {
    throw new Error('PASSWORD_PEPPER is missing or too short — refusing to hash passwords unpeppered');
  }
  return pepper;
}

// Clamped to 200000 even though only server config can set this today (not
// user input) — a runaway value here would blow the 10ms Cloudflare Free CPU
// budget on every login, so treat it as an external input anyway.
const MAX_ITERATIONS = 200000;

function configuredIterations(env: PasswordEnv): number {
  const raw = env.PASSWORD_KDF_ITERATIONS;
  const n = raw ? parseInt(raw, 10) : DEFAULT_ITERATIONS;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ITERATIONS;
  return Math.min(n, MAX_ITERATIONS);
}

// HMAC-SHA256(password) keyed by the pepper. Done before PBKDF2 so the
// pepper is mixed in even if PBKDF2's own cost parameters are ever weakened —
// belt and suspenders, and it's what the spec calls for.
async function pepperPassword(pepper: string, plaintext: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(plaintext));
  return new Uint8Array(sig);
}

async function pbkdf2(peppered: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', peppered, { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256, // 32 bytes
  );
  return new Uint8Array(bits);
}

// Stored format: `pbkdf2$<version>$<iterations>$<salt-b64url>$<hash-b64url>`.
// Version + iterations travel WITH the hash so cost can be raised later
// (bump PASSWORD_KDF_ITERATIONS) without invalidating existing passwords —
// verifyPassword re-derives using whatever count is stored, then flags
// needsRehash if that count is below the currently configured one.
export async function hashPassword(env: PasswordEnv, plaintext: string): Promise<string> {
  const pepper = requirePepper(env);
  const iterations = configuredIterations(env);
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const peppered = await pepperPassword(pepper, plaintext);
  const derived = await pbkdf2(peppered, salt, iterations);
  return `pbkdf2$${HASH_VERSION}$${iterations}$${b64url(salt)}$${b64url(derived)}`;
}

export interface VerifyResult {
  ok: boolean;
  needsRehash: boolean;
}

export async function verifyPassword(env: PasswordEnv, plaintext: string, stored: string): Promise<VerifyResult> {
  const fail: VerifyResult = { ok: false, needsRehash: false };
  if (!stored || typeof stored !== 'string') return fail;
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return fail;
  const [, versionStr, iterationsStr, saltB64, hashB64] = parts;
  const version = parseInt(versionStr, 10);
  const iterations = parseInt(iterationsStr, 10);
  if (version !== HASH_VERSION || !Number.isFinite(iterations) || iterations <= 0) return fail;

  let salt: Uint8Array, expected: Uint8Array;
  try {
    salt = unb64url(saltB64);
    expected = unb64url(hashB64);
  } catch {
    return fail;
  }

  const pepper = requirePepper(env);
  const peppered = await pepperPassword(pepper, plaintext);
  const derived = await pbkdf2(peppered, salt, iterations);
  const ok = constantTimeEqual(derived, expected);
  if (!ok) return fail;

  const needsRehash = iterations < configuredIterations(env);
  return { ok: true, needsRehash };
}

// Constant-cost dummy verification for the "no such account" path in
// password-login — runs a full PBKDF2 at the currently configured iteration
// count against a fixed salt/hash so the response time for "no account" and
// "wrong password" are indistinguishable. Never returns ok:true.
export async function dummyVerify(env: PasswordEnv): Promise<void> {
  const iterations = configuredIterations(env);
  const fixedSalt = new Uint8Array(SALT_BYTES); // all zeros — never used to store real data
  const pepper = requirePepper(env);
  const peppered = await pepperPassword(pepper, 'dummy-password-for-timing-parity');
  await pbkdf2(peppered, fixedSalt, iterations);
}
