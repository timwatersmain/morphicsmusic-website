// Reads src/styles/global.css directly and cross-checks it against
// COLOURWAYS, so the shared module (functions/_lib/community/colourways.ts)
// and the live design tokens can never silently drift apart.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { COLOURWAYS, colourwayHex } from '../../functions/_lib/community/colourways';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS = readFileSync(join(root, 'src/styles/global.css'), 'utf8');

// Every named colourway maps to one of these @theme custom properties.
const TOKEN_BY_KEY: Record<string, string> = {
  cyan: '--color-primary-container',
  mint: '--color-secondary',
  lavender: '--color-tertiary-container',
  pale: '--color-primary',
  green: '--color-secondary-container',
  teal: '--color-surface-tint',
};

function tokenHex(token: string): string | null {
  const m = CSS.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`));
  return m ? m[1].toUpperCase() : null;
}

describe('COLOURWAYS matches the live @theme tokens in global.css', () => {
  it('defines exactly six colourways', () => {
    expect(COLOURWAYS).toHaveLength(6);
  });

  for (const [key, token] of Object.entries(TOKEN_BY_KEY)) {
    it(`${key} matches ${token}`, () => {
      const fromCss = tokenHex(token);
      expect(fromCss).not.toBeNull();
      expect(colourwayHex(key)?.toUpperCase()).toBe(fromCss);
    });
  }

  it('every COLOURWAYS entry has a corresponding CSS token check above', () => {
    expect(COLOURWAYS.map(c => c.key).sort()).toEqual(Object.keys(TOKEN_BY_KEY).sort());
  });

  it('colourwayHex returns null for an unknown key', () => {
    expect(colourwayHex('not-a-real-colour')).toBeNull();
  });
});
