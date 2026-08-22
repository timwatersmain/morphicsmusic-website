// The Discord invite must exist in exactly ONE place, and every surface must
// use that one.
//
// A stale or duplicated invite fails silently — nobody reports a link that
// quietly doesn't work, they just don't join. Before this feature the invite
// appeared once on the entire site (a bare URL in social.astro) while
// /account told people to "run /link in the Morphics Discord" and gave them
// no way to get there. These tests exist so neither can happen again.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(root, 'src');
const COMPONENT = join(SRC, 'components/DiscordInvite.astro');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sourceFiles = walk(SRC).filter(f => /\.(astro|ts|js)$/.test(f));

describe('the Discord invite', () => {
  it('is defined exactly once, in the shared component', () => {
    const defining = sourceFiles.filter(f => /discord\.gg|discord\.com\/invite/.test(readFileSync(f, 'utf8')));
    expect(defining).toEqual([COMPONENT]);
  });

  it('is a permanent invite, and says so', () => {
    // Discord invites expire after 7 days BY DEFAULT. This one was verified
    // as max_age=0; the comment is what stops a future regeneration from
    // quietly shipping a link that dies a week later.
    const src = readFileSync(COMPONENT, 'utf8');
    expect(src).toMatch(/permanent/i);
    expect(src).toMatch(/expire/i);
  });

  it('opens safely in a new tab', () => {
    // target=_blank without rel=noopener hands the opened page a reference
    // back to ours via window.opener.
    const src = readFileSync(COMPONENT, 'utf8');
    const blanks = src.match(/target="_blank"/g) || [];
    const noopeners = src.match(/rel="noopener noreferrer"/g) || [];
    expect(blanks.length).toBeGreaterThan(0);
    expect(noopeners.length).toBe(blanks.length);
  });

  it('appears on every surface that promises it', () => {
    // /account is the one that MUST have it: that panel names the Discord and
    // instructs the fan to run /link there. Naming a place without linking to
    // it is the dead end this feature exists to remove.
    for (const page of [
      'pages/account.astro',
      // CommunityDirectory was on this list (as pages/community/index.astro
      // before the 2026-08-21 merge). It was removed 2026-08-22: /social
      // already links to Discord from the platform grid at its foot, so the
      // invite inside the directory was the same door twice on one page.
      // The profile page below is where it lives for signed-in fans.
      'pages/community/me.astro',
      'pages/order-complete.astro',
    ]) {
      expect(readFileSync(join(SRC, page), 'utf8'), `${page} must render DiscordInvite`)
        .toMatch(/<DiscordInvite/);
    }
  });

  it('is imported by every page that renders it', () => {
    // A page rendering an unimported component fails at build, but this
    // names the file when it happens instead of a stack trace.
    for (const file of sourceFiles.filter(f => /<DiscordInvite/.test(readFileSync(f, 'utf8')))) {
      expect(readFileSync(file, 'utf8'), `${file} renders DiscordInvite without importing it`)
        .toMatch(/import DiscordInvite from/);
    }
  });

  it('tells people the next step, not just to join', () => {
    // Joining alone earns nothing — an unlinked member has no rank. The
    // /link instruction is what makes the invite lead anywhere.
    const src = readFileSync(COMPONENT, 'utf8');
    expect(src).toMatch(/\/link/);
  });
});
