// Shared auth helpers — magic-link issuance + verification, plus signed
// session cookies. No DB beyond KV; sessions are stateless HMAC-signed JWT-
// shaped strings so we don't have to store anything per logged-in user.

const SESSION_TTL_DAYS = 365;
const LOGIN_TTL_MINUTES = 15;

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
export async function signSession(secret: string, email: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 86400;
  const payload = `${email}|${exp}`;
  const sig = await hmac(secret, payload);
  return `${b64url(new TextEncoder().encode(payload))}.${b64url(sig)}`;
}

export async function verifySession(secret: string, cookieValue: string): Promise<string | null> {
  if (!cookieValue) return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return null;
  let payload: string;
  try { payload = new TextDecoder().decode(unb64url(parts[0])); } catch { return null; }
  const sigBytes = (() => { try { return unb64url(parts[1]); } catch { return null; } })();
  if (!sigBytes) return null;
  const expected = await hmac(secret, payload);
  if (!constantTimeEqual(sigBytes, expected)) return null;
  const [email, expStr] = payload.split('|');
  if (!email || !expStr) return null;
  const exp = parseInt(expStr, 10);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return null;
  return email;
}

export function sessionCookieHeader(value: string, opts: { maxAge?: number; clear?: boolean } = {}): string {
  const maxAge = opts.clear ? 0 : (opts.maxAge ?? SESSION_TTL_DAYS * 86400);
  return [
    `morphics_auth=${value}`,
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
