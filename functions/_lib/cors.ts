// Origin allow-list for /api/* responses. With Allow-Credentials: true we
// must echo a verified origin (never a wildcard) and add Vary: Origin so
// shared caches don't pin one origin's response for everyone.
const ALLOWED_ORIGINS = new Set<string>([
  'https://morphicsmusic.com',
  'https://www.morphicsmusic.com',
]);

export function pickAllowedOrigin(request: Request): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  return ALLOWED_ORIGINS.has(origin) ? origin : null;
}

// Apply CORS headers to a response. Always sets Vary: Origin so cache keys
// account for the per-origin echo, even on responses that have no Origin.
export function withCors(response: Response, request: Request): Response {
  const allowed = pickAllowedOrigin(request);
  const headers = new Headers(response.headers);
  headers.append('Vary', 'Origin');
  if (allowed) {
    headers.set('Access-Control-Allow-Origin', allowed);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Wrap a Pages handler so every Response it returns automatically picks up
// the dynamic CORS headers. Saves wrapping every `new Response(...)` call.
export function corsHandler<E = unknown>(fn: PagesFunction<E>): PagesFunction<E> {
  return async (ctx) => {
    const res = await fn(ctx);
    return withCors(res, ctx.request);
  };
}

// Preflight handler — call from onRequestOptions for any /api/* function
// that needs to be reachable from a browser fetch with credentials.
export function preflight(request: Request): Response {
  const allowed = pickAllowedOrigin(request);
  if (!allowed) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': allowed,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin',
    },
  });
}
