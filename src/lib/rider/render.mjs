// One walk over a rider document, shared by everything that renders one.
//
// Kept separate from press-kit/rider.mjs so the walk over a document — marks,
// tables, blocks, section numbering — is one thing with its own tests, rather
// than tangled into the print shell. The class names below are the contract
// between this file and the stylesheet in that shell.
//
// Pure string work, no platform APIs, so it runs anywhere the rider needs
// rendering.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ESCAPES[c]);

/** The placeholders an editor may type. Contact details live in epk.json so
 *  a rider can never quote an address that has moved on. */
export function fillPlaceholders(text, ctx = {}) {
  const mgmt = ctx.mgmt || {};
  let out = String(text ?? '');
  // Without this, dropping the phone number from epk.json leaves a dangling
  // separator mid-sentence — " · ." — rather than a clean line.
  if (!mgmt.phone) out = out.replace(/\s*·\s*\{phone\}/g, '');
  return out
    .replace(/\{contact\}/g, mgmt.contact || '')
    .replace(/\{company\}/g, mgmt.company || '')
    .replace(/\{email\}/g, mgmt.email || '')
    .replace(/\{phone\}/g, mgmt.phone || '')
    .replace(/\{updated\}/g, ctx.updated || '');
}

/** Editor text -> HTML. Escapes FIRST, so an editor types & < > ' " freely
 *  and no amount of pasted markup can reach the page, then applies the three
 *  marks: **bold**, *accent*, ~normal weight~. */
export function inline(text, ctx = {}) {
  return escapeHtml(fillPlaceholders(text, ctx))
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~(.+?)~/g, '<span style="font-weight:400">$1</span>');
}

export function renderTable(tb, ctx = {}) {
  const cols = tb.cols || [];
  const cell = (v, i) => `<td${cols[i] ? ` class="${cols[i]}"` : ''}>${inline(v, ctx)}</td>`;
  const row = (r) => {
    const cells = Array.isArray(r) ? r : r.cells;
    return `<tr${!Array.isArray(r) && r.key ? ' class="key"' : ''}>${cells.map(cell).join('')}</tr>`;
  };
  return `<table><thead><tr>${(tb.head || []).map(h => `<th>${inline(h, ctx)}</th>`).join('')}</tr></thead>`
    + `<tbody>${(tb.rows || []).map(row).join('')}</tbody></table>`;
}

export function renderBlock(b, ctx = {}) {
  if (b.p !== undefined) return `<p>${inline(b.p, ctx)}</p>`;
  if (b.list !== undefined) return `<ul>${b.list.map(i => `<li>${inline(i, ctx)}</li>`).join('')}</ul>`;
  if (b.note !== undefined) return `<div class="note">${inline(b.note, ctx)}</div>`;
  if (b.table !== undefined) return renderTable(b.table, ctx);
  if (b.checklist !== undefined) {
    return `<div class="chk">${b.checklist
      .map(i => `<div class="ck"><span></span>${inline(i, ctx)}</div>`).join('')}</div>`;
  }
  return '';
}

/**
 * A numbering counter, passed through a whole render so section numbers run
 * 01, 02, 03… across all three pages in document order. Counted here rather
 * than stored, so reordering sections in the editor can never leave two 07s
 * in a document a promoter signs.
 */
export function createCounter() {
  let n = 0;
  return { next: () => String(++n).padStart(2, '0') };
}

export function renderSection(s, ctx = {}, attrs = '') {
  const counter = ctx.counter;
  const number = counter ? `<span class="n">${counter.next()}</span>` : '';
  return `
    <h2${attrs}>${number}${inline(s.title, ctx)}</h2>
    ${(s.blocks || []).map(b => renderBlock(b, ctx)).join('\n    ')}`;
}

export function renderSections(list, ctx = {}, attrs = '') {
  return (list || []).map(s => renderSection(s, ctx, attrs)).join('\n');
}

/** Everything a shell needs, with the counter already threaded through. */
export function riderContext(doc, mgmt = {}) {
  return { mgmt, updated: doc.updated, counter: createCounter() };
}
