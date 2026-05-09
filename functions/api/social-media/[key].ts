// GET /api/social-media/<key>
// Proxies a public social-media object from the R2 bucket. Lives so the
// bucket itself can stay private (r2.dev disabled) while the social page
// can still embed videos. Strict allow-list: key must be a flat-named
// file matching the expected hash.mp4 pattern, never anything under the
// masters/ prefix — that's gated by /api/download with auth.

interface Env {
  MASTERS: R2Bucket;
}

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

// Flat-named files only — alphanumeric + underscore + dash + a single
// extension. Rejects path traversal (/, .., \), the masters/ prefix
// (already implicit since `/` is rejected), and any non-allowed ext.
function isSafeKey(key: string): boolean {
  if (!key || key.length > 128) return false;
  if (!/^[A-Za-z0-9_-]+\.(mp4|mov|webm|jpg|jpeg|png)$/.test(key)) return false;
  return true;
}

export const onRequestGet: PagesFunction<Env> = async ({ params, env, request }) => {
  const key = String(params.key || '');
  if (!isSafeKey(key)) return new Response('invalid key', { status: 400 });

  const obj = await env.MASTERS.get(key);
  if (!obj) return new Response('not found', { status: 404 });

  const ext = (key.split('.').pop() || '').toLowerCase();
  const headers = new Headers({
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': String(obj.size),
    'Accept-Ranges': 'bytes',
    // These are public marketing assets — let CDN cache them aggressively.
    'Cache-Control': 'public, max-age=31536000, immutable',
  });

  // Pass through Range requests so the <video> element can seek without
  // pulling the entire file. R2's get() only returns the full object;
  // for ranged responses we'd need .get(key, { range: ... }) — done below.
  const range = request.headers.get('Range');
  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : obj.size - 1;
      const ranged = await env.MASTERS.get(key, { range: { offset: start, length: end - start + 1 } });
      if (!ranged) return new Response('not found', { status: 404 });
      headers.set('Content-Range', `bytes ${start}-${end}/${obj.size}`);
      headers.set('Content-Length', String(end - start + 1));
      return new Response(ranged.body, { status: 206, headers });
    }
  }

  return new Response(obj.body, { headers });
};
