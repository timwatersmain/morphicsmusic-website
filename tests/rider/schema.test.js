// The validator is the only thing standing between a browser form and a
// document that goes to a promoter, so these tests are about STRUCTURE
// damage, not taste: a torn table, a lost block, a fourth page.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateRider, normalizeRider, cleanText, LIMITS } from '../../src/lib/rider/schema.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const live = () => JSON.parse(readFileSync(join(ROOT, 'src/data/rider.json'), 'utf8'));

const errorPaths = (doc) => validateRider(doc).errors.map(e => e.path);

describe('the rider that ships', () => {
  it('is valid', () => {
    const result = validateRider(live());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('survives a round trip through normalize unchanged', () => {
    // Normalize runs on every save. If it altered real content, every save
    // would quietly rewrite the rider.
    const doc = normalizeRider(live());
    expect(validateRider(doc).ok).toBe(true);
    expect(normalizeRider(doc)).toEqual(doc);
  });

  it('keeps the hospitality wording the editor last agreed on', () => {
    const hospitality = live().page3.sections.find(s => s.title === 'Hospitality');
    const bullets = hospitality.blocks.find(b => b.list).list.join(' ');
    expect(bullets).toContain('Alcoholic and non-alcoholic drinks');
    expect(bullets).not.toMatch(/beers|hot meal|pizza/i);
  });
});

describe('validateRider', () => {
  it('rejects anything that is not a document', () => {
    for (const bad of [null, undefined, 'a rider', 42, []]) {
      expect(validateRider(bad).ok).toBe(false);
    }
  });

  it('names the field that is wrong', () => {
    const doc = live();
    doc.page3.sections[0].blocks[0] = { p: '' };
    expect(errorPaths(doc)).toContain('page3.sections[0].blocks[0].p');
  });

  it('rejects a table row with the wrong number of cells', () => {
    const doc = live();
    doc.page1.formats.rows[0] = ['Live A/V', 'only two cells'];
    const err = validateRider(doc).errors.find(e => e.path === 'page1.formats.rows[0]');
    expect(err.message).toMatch(/2 cells but the table has 3 columns/);
  });

  it('rejects a block that claims to be two things at once', () => {
    const doc = live();
    doc.page3.sections[0].blocks[0] = { p: 'text', list: ['bullet'] };
    const err = validateRider(doc).errors.find(e => e.path === 'page3.sections[0].blocks[0]');
    expect(err.message).toMatch(/more than one kind/);
  });

  it('rejects an unknown block kind rather than rendering nothing', () => {
    const doc = live();
    doc.page3.sections[0].blocks[0] = { paragraph: 'wrong key' };
    expect(errorPaths(doc)).toContain('page3.sections[0].blocks[0]');
  });

  it('rejects an unknown column style', () => {
    const doc = live();
    doc.page1.formats.cols = ['f', 'zzz', ''];
    expect(errorPaths(doc)).toContain('page1.formats.cols[1]');
  });

  it('rejects text past the layout limits', () => {
    const doc = live();
    doc.page1.sections[0].title = 'x'.repeat(LIMITS.title + 1);
    expect(errorPaths(doc)).toContain('page1.sections[0].title');
  });

  it('rejects a document that would overflow three pages', () => {
    const doc = live();
    const one = doc.page3.sections[0];
    doc.page3.sections = Array.from({ length: LIMITS.sections + 1 }, () => structuredClone(one));
    expect(errorPaths(doc)).toContain('page3.sections');
  });

  it('rejects a document over the byte ceiling outright', () => {
    const doc = live();
    doc.page1.intro = 'x'.repeat(LIMITS.bytes);
    const result = validateRider(doc);
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/over the .* limit/);
  });

  it('requires an empty section to be removed, not left blank', () => {
    const doc = live();
    doc.page1.sections[0].blocks = [];
    expect(errorPaths(doc)).toContain('page1.sections[0].blocks');
  });

  it('accepts optional fields being absent', () => {
    const doc = live();
    delete doc.page1.note;
    delete doc.page3.closingNote;
    expect(validateRider(doc).ok).toBe(true);
  });
});

describe('normalizeRider', () => {
  it('drops keys the renderer never reads', () => {
    const doc = live();
    doc._readme = ['editing notes that must not reach the live document'];
    doc.page1.sections[0].colour = 'red';
    const out = normalizeRider(doc);
    expect(out._readme).toBeUndefined();
    expect(out.page1.sections[0].colour).toBeUndefined();
  });

  it('flattens pasted line breaks instead of breaking the PDF', () => {
    const doc = live();
    doc.page1.intro = 'Pasted from\na word processor\r\n\twith tabs.';
    expect(normalizeRider(doc).page1.intro).toBe('Pasted from a word processor with tabs.');
  });

  it('preserves the key flag on a shaded table row', () => {
    const rows = normalizeRider(live()).page1.sections[1].blocks[0].table.rows;
    expect(rows[0].key).toBe(true);
    expect(Array.isArray(rows[2])).toBe(true);
  });
});

describe('cleanText', () => {
  it('strips control characters that would break line breaking', () => {
    const withControls = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(127) + 'c';
    expect(cleanText(withControls)).toBe('abc');
  });

  it('leaves the marks the renderer understands alone', () => {
    expect(cleanText('**bold** and *accent* and ~normal~')).toBe('**bold** and *accent* and ~normal~');
  });
});
