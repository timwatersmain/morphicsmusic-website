// The shared content walk. Both the PDF and the live page render through
// this, so a change here shows up in a signed document — these tests pin the
// behaviour the layout and the stylesheets depend on.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  inline, escapeHtml, fillPlaceholders, renderBlock, renderTable,
  renderSections, riderContext, createCounter,
} from '../../src/lib/rider/render.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const doc = JSON.parse(readFileSync(join(ROOT, 'src/data/rider.json'), 'utf8'));
const mgmt = JSON.parse(readFileSync(join(ROOT, 'src/data/epk.json'), 'utf8')).management || {};

describe('inline marks', () => {
  const ctx = { mgmt: {}, updated: 'August 2026' };

  it('renders the three marks', () => {
    expect(inline('**bold**', ctx)).toBe('<b>bold</b>');
    expect(inline('*accent*', ctx)).toBe('<em>accent</em>');
    expect(inline('2 ~(4 pref.)~', ctx)).toBe('2 <span style="font-weight:400">(4 pref.)</span>');
  });

  it('escapes before it marks up, so typed markup can never reach the page', () => {
    expect(inline('<script>alert(1)</script>', ctx))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(inline('**<b>**', ctx)).toBe('<b>&lt;b&gt;</b>');
  });

  it('leaves an ampersand an editor typed as an ampersand', () => {
    expect(inline('Comps & payment', ctx)).toBe('Comps &amp; payment');
    expect(escapeHtml("artist's")).toBe('artist&#39;s');
  });
});

describe('placeholders', () => {
  it('fills contact details from management', () => {
    const out = fillPlaceholders('{contact} · {email}', { mgmt: { contact: 'A', email: 'b@c.d' } });
    expect(out).toBe('A · b@c.d');
  });

  it('drops a dangling separator when there is no phone number', () => {
    const out = fillPlaceholders('{email} · {phone}.', { mgmt: { email: 'b@c.d' } });
    expect(out).toBe('b@c.d.');
  });
});

describe('blocks', () => {
  const ctx = { mgmt: {} };

  it('renders each kind with the classes the stylesheets target', () => {
    expect(renderBlock({ p: 'x' }, ctx)).toBe('<p>x</p>');
    expect(renderBlock({ list: ['a', 'b'] }, ctx)).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderBlock({ note: 'x' }, ctx)).toBe('<div class="note">x</div>');
    expect(renderBlock({ checklist: ['a'] }, ctx))
      .toBe('<div class="chk"><div class="ck"><span></span>a</div></div>');
  });

  it('shades a key row and applies column styles', () => {
    const html = renderTable({
      head: ['Qty', 'Item'],
      cols: ['q', ''],
      rows: [{ key: true, cells: ['2', 'CDJ'] }, ['1', 'Hub']],
    }, ctx);
    expect(html).toContain('<tr class="key"><td class="q">2</td><td>CDJ</td></tr>');
    expect(html).toContain('<tr><td class="q">1</td><td>Hub</td></tr>');
  });
});

describe('section numbering', () => {
  it('runs unbroken across all three pages, in document order', () => {
    const ctx = riderContext(doc, mgmt);
    const html = [doc.page1, doc.page2, doc.page3]
      .map(page => renderSections(page.sections, ctx)).join('');
    const numbers = [...html.matchAll(/<span class="n">(\d\d)<\/span>/g)].map(m => m[1]);
    expect(numbers).toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10']);
  });

  it('renumbers rather than renaming when a section moves', () => {
    const counter = createCounter();
    const ctx = { mgmt, counter };
    const reordered = [...doc.page3.sections].reverse();
    const html = renderSections(reordered, ctx);
    const first = html.indexOf('01');
    expect(html.slice(first, first + 120)).toContain(reordered[0].title);
  });
});
