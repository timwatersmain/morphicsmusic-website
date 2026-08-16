import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const redirects = readFileSync(
  fileURLToPath(new URL('../../public/_redirects', import.meta.url)),
  'utf8',
);

function ruleFor(source) {
  return redirects
    .split('\n')
    .map(l => l.trim())
    .find(l => l.startsWith(source));
}

describe('public/_redirects — /community/u/* fan profile rewrite', () => {
  it('targets the canonical trailing-slash directory URL, not the bare directory', () => {
    // Astro's static output emits /community/profile as a directory
    // (dist/community/profile/index.html). A target of "/community/profile"
    // (no trailing slash) makes Cloudflare's asset server 308-redirect the
    // request to add the slash -- and that redirect replaces the browser's
    // URL, discarding the /community/u/<handle> path segment the client
    // script reads from location.pathname. Every profile then renders as
    // "No such fan." This is the bug this rule exists to avoid.
    const line = ruleFor('/community/u/*');
    expect(line, 'expected a /community/u/* rule in public/_redirects').toBeTruthy();

    const target = line.split(/\s+/)[1];
    expect(target).toBe('/community/profile/');
  });

  it('does not target a literal index.html path', () => {
    // The obvious-looking fix -- pointing straight at
    // "/community/profile/index.html" -- looks correct in source review but
    // is silently dropped: Cloudflare's redirect validator (reproduced here
    // via `wrangler pages dev`) treats any 200-rewrite target ending in
    // "index.html" as a potential infinite loop and ignores the whole rule,
    // a known upstream false positive (cloudflare/workers-sdk#11824). A
    // dropped rule is worse than the original bug -- /community/u/* would
    // get no rewrite at all. This test pins the working fix (the
    // trailing-slash directory URL) against a regression back to that
    // tempting-but-broken alternative.
    const line = ruleFor('/community/u/*');
    const target = line.split(/\s+/)[1];
    expect(target.endsWith('index.html')).toBe(false);
  });

  it('does not shadow the existing /signal, /sonics, /community, or /community/me rules', () => {
    const lines = redirects
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));

    const communityUIndex = lines.findIndex(l => l.startsWith('/community/u/*'));
    expect(communityUIndex).toBeGreaterThanOrEqual(0);

    // /signal and /sonics are unrelated top-level 301s; order relative to
    // them doesn't matter for shadowing, but they must still be present.
    expect(lines.some(l => l.startsWith('/signal '))).toBe(true);
    expect(lines.some(l => l.startsWith('/sonics '))).toBe(true);

    // /community/u/* must not appear before a bare /community or
    // /community/me rule that would otherwise be shadowed -- no such rules
    // exist today (those are real pages, not _redirects entries), but if
    // one is ever added it must come first (Cloudflare matches top to
    // bottom, first match wins) or this wildcard would swallow it.
    const communityExact = lines.findIndex(l => l.startsWith('/community ') || l.startsWith('/community/me '));
    if (communityExact !== -1) {
      expect(communityExact).toBeLessThan(communityUIndex);
    }
  });
});
