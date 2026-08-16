// Shared auth helpers — magic-link issuance + verification, plus signed
// session cookies. Sessions are HMAC-signed strings so we don't store one
// row per logged-in user, but a per-email session_ver counter in KV gives
// us a kill-switch: bumping it (e.g. from /api/auth/logout) invalidates
// every session that was issued before the bump, even ones still inside
// their TTL.

const SESSION_TTL_DAYS = 30;
const REMEMBER_TTL_DAYS = 365;
const LOGIN_TTL_MINUTES = 15;
const COOKIE_NAME = '__Host-morphics_auth';
const LEGACY_COOKIE_NAME = 'morphics_auth';

export const SESSION_COOKIE = COOKIE_NAME;
export const LEGACY_SESSION_COOKIE = LEGACY_COOKIE_NAME;
export const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 86400;
export const REMEMBER_TTL_SECONDS = REMEMBER_TTL_DAYS * 86400;

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
async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

// ── Session cookies ─────────────────────────────────────────────────────
// Payload is `email|exp|ver`. ver is an integer that must match the latest
// session_ver:<email> stored in KV; bumping it invalidates every cookie
// issued before the bump.
// ttlDays defaults to the existing 30 so every current caller is unaffected.
// "Remember me" logins pass REMEMBER_TTL_DAYS (365) explicitly.
export async function signSession(secret: string, email: string, ver: number, ttlDays: number = SESSION_TTL_DAYS): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlDays * 86400;
  const payload = `${email}|${exp}|${ver}`;
  const sig = await hmac(secret, payload);
  return `${b64url(new TextEncoder().encode(payload))}.${b64url(sig)}`;
}

// Read the current session version for an email (defaults to 0 if never set).
export async function getSessionVer(env: { DOWNLOADS: KVNamespace }, email: string): Promise<number> {
  const raw = await env.DOWNLOADS.get(`session_ver:${email.toLowerCase().trim()}`);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Bump the session version for an email — invalidates every cookie minted
// against an older value. Called by /api/auth/logout (and on suspected
// compromise from any other surface).
export async function bumpSessionVer(env: { DOWNLOADS: KVNamespace }, email: string): Promise<number> {
  const next = (await getSessionVer(env, email)) + 1;
  await env.DOWNLOADS.put(`session_ver:${email.toLowerCase().trim()}`, String(next));
  return next;
}

export async function verifySession(
  secret: string,
  cookieValue: string,
  env?: { DOWNLOADS: KVNamespace },
): Promise<string | null> {
  if (!cookieValue) return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return null;
  let payload: string;
  try { payload = new TextDecoder().decode(unb64url(parts[0])); } catch { return null; }
  const sigBytes = (() => { try { return unb64url(parts[1]); } catch { return null; } })();
  if (!sigBytes) return null;
  const expected = await hmac(secret, payload);
  if (!constantTimeEqual(sigBytes, expected)) return null;
  const fields = payload.split('|');
  // Old 2-field payloads (email|exp) are no longer accepted — they predate
  // the ver field and so can't be revoked. Forces re-login post-deploy.
  if (fields.length !== 3) return null;
  const [email, expStr, verStr] = fields;
  if (!email || !expStr || !verStr) return null;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  const cookieVer = parseInt(verStr, 10);
  if (!Number.isFinite(cookieVer) || cookieVer < 0) return null;
  // env is optional only so callers that already failed cookie integrity
  // can short-circuit without a KV roundtrip — but in practice every
  // production caller passes env, and we require it to enforce ver.
  if (env) {
    const currentVer = await getSessionVer(env, email);
    if (cookieVer !== currentVer) return null;
  }
  return email;
}

export function sessionCookieHeader(value: string, opts: { maxAge?: number; clear?: boolean; legacy?: boolean } = {}): string {
  const maxAge = opts.clear ? 0 : (opts.maxAge ?? SESSION_TTL_DAYS * 86400);
  // __Host- prefix browsers will reject if Domain= is set or Path != / or
  // Secure missing — that's the entire point: it pins the cookie to this
  // exact host and stops any subdomain (waters., portfolio.) from ever
  // overwriting it via a sibling-set cookie. Use `legacy:true` to clear
  // the pre-prefix cookie that older deploys minted.
  const name = opts.legacy ? LEGACY_COOKIE_NAME : COOKIE_NAME;
  return [
    `${name}=${value}`,
    `Path=/`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Lax`,
    `Max-Age=${maxAge}`,
  ].join('; ');
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') || '';
  const parts = header.split(';').map(s => s.trim());
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i) === name) return decodeURIComponent(p.slice(i + 1));
  }
  return null;
}

// ── Magic-link tokens stored in KV ──────────────────────────────────────
export interface LoginGrant {
  email: string;
  redirect?: string;
  created_at: number;
}

export async function issueLoginToken(env: { DOWNLOADS: KVNamespace }, email: string, redirect?: string): Promise<string> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = b64url(bytes);
  const grant: LoginGrant = {
    email: email.toLowerCase().trim(),
    redirect,
    created_at: Math.floor(Date.now() / 1000),
  };
  await env.DOWNLOADS.put(`login:${token}`, JSON.stringify(grant), {
    expirationTtl: LOGIN_TTL_MINUTES * 60,
  });
  return token;
}

export async function consumeLoginToken(
  env: { DOWNLOADS: KVNamespace },
  token: string,
): Promise<LoginGrant | null> {
  const raw = await env.DOWNLOADS.get(`login:${token}`);
  if (!raw) return null;
  // One-shot — delete on consume.
  await env.DOWNLOADS.delete(`login:${token}`);
  try { return JSON.parse(raw); } catch { return null; }
}
