// Shared rate-limit primitive for all /api/* endpoints.
//
// Uses a fixed-window counter in KV (binding: DOWNLOADS). Each endpoint
// names its own scope so counters never collide across routes; bucket
// distinguishes per-IP from per-email (or any other actor key).
//
// Returns a structured result so callers can produce 429 JSON with
// Retry-After instead of relying on edge-level Block actions, which
// IP-blanket the whole site and look like "you have been banned" to a
// real customer behind a NAT.

export interface RateLimitResult {
  ok: boolean;
  retryAfter: number;
  remaining: number;
}

export interface RateLimitEnv {
  DOWNLOADS: KVNamespace;
}

export async function rateLimit(
  env: RateLimitEnv,
  scope: string,
  bucket: string,
  id: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  const key = `rl:${scope}:${bucket}:${id}`;
  const raw = await env.DOWNLOADS.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= limit) {
    return { ok: false, retryAfter: windowSec, remaining: 0 };
  }
  await env.DOWNLOADS.put(key, String(count + 1), { expirationTtl: windowSec });
  return { ok: true, retryAfter: 0, remaining: limit - count - 1 };
}

// Standard 429 response — clean JSON + Retry-After. Use for endpoints the
// client will surface to the user ("please wait Ns and try again").
export function rateLimitedJson(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({ error: 'rate_limited', retry_after: result.retryAfter }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(result.retryAfter),
      },
    },
  );
}

// Plain-text 429 — for endpoints that stream binary or don't have a JSON
// client (e.g. /api/download, /api/social-media/[key]).
export function rateLimitedText(result: RateLimitResult): Response {
  return new Response('rate limited', {
    status: 429,
    headers: { 'Retry-After': String(result.retryAfter) },
  });
}

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}
