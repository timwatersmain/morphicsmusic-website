// What a rider document is allowed to be.
//
// press-kit/rider.mjs runs this before it renders, so a hand edit that breaks
// the structure fails the build with the field named, instead of printing a
// torn table into a document that goes to a promoter.
//
// Every limit below is there because exceeding it damages the LAYOUT, not
// because the content would be wrong — this is not a style guide, it is a
// structural guard.

export const LIMITS = {
  title: 80,          // section headings sit on one line beside their number
  paragraph: 1200,    // a clause; longer means it wanted to be a list
  bullet: 400,
  cell: 300,
  sections: 20,       // per page
  blocks: 12,         // per section
  items: 24,          // bullets or tick boxes in one block
  rows: 12,           // table rows
  cells: 6,           // cells in one row
  bytes: 60000,       // whole document, serialised
};

const COL_STYLES = new Set(['', 'f', 'q']);
const BLOCK_KINDS = ['p', 'list', 'note', 'checklist', 'table'];

/** Control characters break the PDF renderer's line breaking; tabs and
 *  newlines inside a field are silently normalised rather than rejected,
 *  because pasting from a Word doc is the normal way text arrives here. */
export function cleanText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

class Check {
  constructor() { this.errors = []; }
  fail(path, message) { this.errors.push({ path, message }); return false; }

  text(value, path, max, { required = true } = {}) {
    if (value === undefined || value === null) {
      return required ? this.fail(path, 'is required') : true;
    }
    if (typeof value !== 'string') return this.fail(path, 'must be text');
    const clean = cleanText(value);
    if (required && !clean) return this.fail(path, 'cannot be empty');
    if (clean.length > max) return this.fail(path, `is longer than ${max} characters`);
    return true;
  }

  list(value, path, max, itemMax) {
    if (!Array.isArray(value)) return this.fail(path, 'must be a list');
    if (value.length === 0) return this.fail(path, 'cannot be empty');
    if (value.length > max) return this.fail(path, `has more than ${max} items`);
    value.forEach((item, i) => this.text(item, `${path}[${i}]`, itemMax));
    return true;
  }

  table(value, path) {
    if (!value || typeof value !== 'object') return this.fail(path, 'must be a table');
    if (!Array.isArray(value.head) || value.head.length === 0) {
      return this.fail(`${path}.head`, 'needs at least one column heading');
    }
    if (value.head.length > LIMITS.cells) {
      return this.fail(`${path}.head`, `has more than ${LIMITS.cells} columns`);
    }
    value.head.forEach((h, i) => this.text(h, `${path}.head[${i}]`, LIMITS.title));

    if (value.cols !== undefined) {
      if (!Array.isArray(value.cols)) return this.fail(`${path}.cols`, 'must be a list');
      value.cols.forEach((c, i) => {
        if (!COL_STYLES.has(String(c ?? ''))) {
          this.fail(`${path}.cols[${i}]`, 'must be "", "f" or "q"');
        }
      });
    }

    if (!Array.isArray(value.rows) || value.rows.length === 0) {
      return this.fail(`${path}.rows`, 'needs at least one row');
    }
    if (value.rows.length > LIMITS.rows) {
      return this.fail(`${path}.rows`, `has more than ${LIMITS.rows} rows`);
    }
    value.rows.forEach((row, i) => {
      const rowPath = `${path}.rows[${i}]`;
      const cells = Array.isArray(row) ? row : row && row.cells;
      if (!Array.isArray(cells)) return this.fail(rowPath, 'must be a list of cells, or { key, cells }');
      // A row with a different cell count than the heading prints as a torn
      // table rather than as an error, which is exactly the failure this
      // whole file exists to stop.
      if (cells.length !== value.head.length) {
        return this.fail(rowPath, `has ${cells.length} cells but the table has ${value.head.length} columns`);
      }
      cells.forEach((c, j) => this.text(c, `${rowPath}[${j}]`, LIMITS.cell, { required: false }));
      return true;
    });
    return true;
  }

  block(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return this.fail(path, 'must be a block');
    }
    const kinds = BLOCK_KINDS.filter(k => value[k] !== undefined);
    if (kinds.length === 0) {
      return this.fail(path, `must be one of: ${BLOCK_KINDS.join(', ')}`);
    }
    if (kinds.length > 1) {
      // Two kinds in one block renders only the first — silently losing the
      // rest of someone's edit. Reject rather than drop.
      return this.fail(path, `has more than one kind (${kinds.join(', ')}); use separate blocks`);
    }
    const kind = kinds[0];
    if (kind === 'p' || kind === 'note') return this.text(value[kind], `${path}.${kind}`, LIMITS.paragraph);
    if (kind === 'list' || kind === 'checklist') {
      return this.list(value[kind], `${path}.${kind}`, LIMITS.items, LIMITS.bullet);
    }
    return this.table(value.table, `${path}.table`);
  }

  section(value, path) {
    if (!value || typeof value !== 'object') return this.fail(path, 'must be a section');
    this.text(value.title, `${path}.title`, LIMITS.title);
    if (!Array.isArray(value.blocks) || value.blocks.length === 0) {
      return this.fail(`${path}.blocks`, 'needs at least one block');
    }
    if (value.blocks.length > LIMITS.blocks) {
      return this.fail(`${path}.blocks`, `has more than ${LIMITS.blocks} blocks`);
    }
    value.blocks.forEach((b, i) => this.block(b, `${path}.blocks[${i}]`));
    return true;
  }

  sections(value, path) {
    if (!Array.isArray(value)) return this.fail(path, 'must be a list of sections');
    if (value.length > LIMITS.sections) {
      return this.fail(path, `has more than ${LIMITS.sections} sections`);
    }
    value.forEach((s, i) => this.section(s, `${path}[${i}]`));
    return true;
  }
}

/**
 * Validate a whole rider document.
 * @returns {{ok: boolean, errors: {path: string, message: string}[]}}
 */
export function validateRider(doc) {
  const c = new Check();
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, errors: [{ path: '', message: 'must be a rider document' }] };
  }

  const size = JSON.stringify(doc).length;
  if (size > LIMITS.bytes) {
    return { ok: false, errors: [{ path: '', message: `is ${size} bytes, over the ${LIMITS.bytes} limit` }] };
  }

  c.text(doc.updated, 'updated', LIMITS.title);
  c.text(doc.coverTitle, 'coverTitle', LIMITS.title);
  c.text(doc.coverStrap, 'coverStrap', LIMITS.paragraph);
  c.text(doc.footer, 'footer', LIMITS.paragraph);

  const p1 = doc.page1 || {};
  c.text(p1.intro, 'page1.intro', LIMITS.paragraph);
  c.table(p1.formats, 'page1.formats');
  c.text(p1.note, 'page1.note', LIMITS.paragraph, { required: false });
  c.sections(p1.sections, 'page1.sections');

  const p2 = doc.page2 || {};
  c.text(p2.title, 'page2.title', LIMITS.title);
  c.text(p2.intro, 'page2.intro', LIMITS.paragraph);
  c.sections(p2.sections, 'page2.sections');

  const p3 = doc.page3 || {};
  c.text(p3.title, 'page3.title', LIMITS.title);
  c.sections(p3.sections, 'page3.sections');
  c.text(p3.closingNote, 'page3.closingNote', LIMITS.paragraph, { required: false });
  if (p3.confirm !== undefined) c.section(p3.confirm, 'page3.confirm');
  if (p3.signature !== undefined) {
    if (!Array.isArray(p3.signature)) c.fail('page3.signature', 'must be a list');
    else p3.signature.forEach((s, i) => {
      c.text(s && s.label, `page3.signature[${i}].label`, LIMITS.title);
      c.text(s && s.under, `page3.signature[${i}].under`, LIMITS.title, { required: false });
    });
  }

  return { ok: c.errors.length === 0, errors: c.errors };
}

/** Strip every field the renderer does not read, and clean every string.
 *  Nothing in the build calls this — it belongs to the web editor shelved at
 *  ~/Desktop/MorphicsBrain/shelved/rider-editor-2026-08-24, which normalised
 *  on the way into storage. Kept, with its tests, so reviving that is a copy
 *  rather than a rewrite.
 *  Runs AFTER validation, on the way into storage, so what is stored is
 *  exactly what will be rendered — no stowaway keys from an old shape, and
 *  no `_readme` copy drifting out of date in the live document. */
export function normalizeRider(doc) {
  const text = (v) => cleanText(v);
  const optText = (v) => (v === undefined || v === null ? undefined : cleanText(v));

  const table = (t) => {
    const out = { head: t.head.map(text), rows: t.rows.map(r => (
      Array.isArray(r) ? r.map(text) : { key: !!r.key, cells: r.cells.map(text) }
    )) };
    if (Array.isArray(t.cols)) out.cols = t.cols.map(c => String(c ?? ''));
    return out;
  };
  const block = (b) => {
    if (b.p !== undefined) return { p: text(b.p) };
    if (b.note !== undefined) return { note: text(b.note) };
    if (b.list !== undefined) return { list: b.list.map(text) };
    if (b.checklist !== undefined) return { checklist: b.checklist.map(text) };
    return { table: table(b.table) };
  };
  const section = (s) => ({ title: text(s.title), blocks: s.blocks.map(block) });
  const sections = (list) => (list || []).map(section);

  const out = {
    updated: text(doc.updated),
    coverTitle: text(doc.coverTitle),
    coverStrap: text(doc.coverStrap),
    footer: text(doc.footer),
    page1: {
      intro: text(doc.page1.intro),
      formats: table(doc.page1.formats),
      sections: sections(doc.page1.sections),
    },
    page2: {
      title: text(doc.page2.title),
      intro: text(doc.page2.intro),
      sections: sections(doc.page2.sections),
    },
    page3: {
      title: text(doc.page3.title),
      sections: sections(doc.page3.sections),
    },
  };
  const p1note = optText(doc.page1.note);
  if (p1note) out.page1.note = p1note;
  const closing = optText(doc.page3.closingNote);
  if (closing) out.page3.closingNote = closing;
  if (doc.page3.confirm) out.page3.confirm = section(doc.page3.confirm);
  if (Array.isArray(doc.page3.signature)) {
    out.page3.signature = doc.page3.signature.map(s => ({
      label: text(s.label), under: s.under ? text(s.under) : '',
    }));
  }
  return out;
}
