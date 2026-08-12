import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../../public/glyphs/svg/', import.meta.url));

describe('glyph assets', () => {
  it('ships every letter of the tagline', () => {
    for (const ch of 'THEONLYCONSTANTISCHANGE') {
      expect(existsSync(dir + ch + '.svg'), ch + '.svg missing').toBe(true);
    }
  });

  it('uses a 120x120 viewBox with a fillet-filtered root group', () => {
    const svg = readFileSync(dir + 'A.svg', 'utf8');
    expect(svg).toContain('viewBox="0 0 120 120"');
    expect(svg).toContain('<g filter="url(#fillet)">');
  });
});
