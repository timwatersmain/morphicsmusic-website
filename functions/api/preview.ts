// /api/preview?key=previews/<slug>/<file>.mp3
//   Public, purchase-free streaming of the 128k MP3 previews. Range-enabled so
//   the <audio> element can seek. The allow-list is previews.json — only keys
//   it publishes are served, so this endpoint can NEVER reach the gated
//   masters/ WAVs even if a caller forges a key.

import previews from '../../src/data/previews.json';

interface Env {
  MASTERS: R2Bucket;
}

// Flat set of every key previews.json publishes.
const ALLOWED: Set<string> = new Set(
  Object.values((previews as any).previews || {}).flatMap((arr: any) =>
    (arr as Array<{ key?: string }>).map(e => e.key).filter(Boolean) as string[],
  ),
);

function parseRange(header: string | null, size: number): { offset: number; length: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, s, e] = m;
  let start = s === '' ? NaN : parseInt(s, 10);
  let end = e === '' ? NaN : parseInt(e, 10);
  if (Number.isNaN(start)) {
    // suffix range: bytes=-N  → last N bytes
    if (Number.isNaN(end)) return null;
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }
  if (start > end || start < 0 || end >= size) return null;
  return { offset: start, length: end - start + 1 };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';

  if (!key || key.includes('..') || key.includes('\0') || !key.startsWith('previews/')) {
    return new Response('invalid key', { status: 400 });
  }
  if (!ALLOWED.has(key)) {
    return new Response('not found', { status: 404 });
  }

  // Probe size for Range math (cheap metadata read).
  const head = await env.MASTERS.head(key);
  if (!head) return new Response('not found', { status: 404 });
  const size = head.size;

  const range = parseRange(request.headers.get('Range'), size);
  const obj = await env.MASTERS.get(key, range ? { range } : undefined);
  if (!obj) return new Response('not found', { status: 404 });

  const headers: Record<string, string> = {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    // Previews are immutable per key; let the CDN + browser cache hard.
    'Cache-Control': 'public, max-age=31536000, immutable',
  };

  if (range) {
    headers['Content-Length'] = String(range.length);
    headers['Content-Range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`;
    return new Response(obj.body, { status: 206, headers });
  }

  headers['Content-Length'] = String(size);
  return new Response(obj.body, { status: 200, headers });
};
