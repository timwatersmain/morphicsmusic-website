// The Morphics constructed alphabet: character -> SVG basename in /glyphs/svg/.
// Ported verbatim from Spelling.dc.html (the design handoff). Unmapped characters
// are skipped by the sequencer, never substituted.
export const CHARMAP = (() => {
  const m = {};
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach(c => { m[c] = c; });
  '0123456789'.split('').forEach((c, i) => { m[c] = 'num-' + i; });
  const sym = {
    '.': 'period', ',': 'comma', ':': 'colon', ';': 'semicolon', '!': 'exclam', '?': 'question',
    "'": 'apostrophe', '"': 'quote', '`': 'backtick', '-': 'hyphen', '_': 'underscore', '/': 'slash',
    '\\': 'backslash', '|': 'pipe', '(': 'paren-open', ')': 'paren-close', '[': 'bracket-open',
    ']': 'bracket-close', '{': 'brace-open', '}': 'brace-close', '<': 'less', '>': 'greater',
    '+': 'plus', '=': 'equals', '*': 'asterisk', '#': 'hash', '%': 'percent', '@': 'at', '&': 'ampersand',
    '^': 'caret', '~': 'tilde', '$': 'dollar', '£': 'pound', '€': 'euro', '¥': 'yen',
    '°': 'degree', '·': 'bullet'
  };
  Object.keys(sym).forEach(k => { m[k] = 'sym-' + sym[k]; });
  return m;
})();

// Half the 13-unit house stroke, in the 120x120 glyph artboard's units.
export const HALF = 6.5;

// Everything lives on a 120x120 artboard whose centre is (60, 60).
export const CENTER = 60;

export const PHRASE = 'THE ONLY CONSTANT IS CHANGE';
