// Shared Cloudflare Turnstile verification for the password-auth endpoints
// (signup, password-login). login.ts/verify.ts keep their own inline copy —
// they're the working magic-link path and are left untouched — but new
// endpoints share this one rather than re-pasting it a third time.

export interface TurnstileEnv {
  TURNSTILE_SECRET_KEY?: string;
}

// Returns true on success, false on any failure. If TURNSTILE_SECRET_KEY is
// unset (e.g. local dev) the challenge is treated as disabled — the caller
// still applies rate limits.
export async function verifyTurnstile(env: TurnstileEnv, token: string, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const form = new FormData();
    form.append('secret', env.TURNSTILE_SECRET_KEY);
    form.append('response', token);
    if (ip && ip !== 'unknown') form.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data: any = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}
