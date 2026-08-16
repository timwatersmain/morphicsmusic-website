// The single source of truth for avatar-tier colourways. avatar_catalogue
// rows store a named `colourway` key (e.g. 'cyan'), never a hex value —
// this module is the only place a hex is written down. The picker/renderer
// UI (a later task) imports this same module rather than keeping its own
// copy, so the two can never drift.
//
// Hex values are copied from the LIVE @theme block in src/styles/global.css
// (NOT tailwind.config.mjs, which is stale). tests/community/colourways.test.ts
// reads global.css directly and asserts these match, so any future edit to
// the design tokens fails loudly here instead of silently going out of sync.

export interface Colourway {
  key: string;
  hex: string;
}

export const COLOURWAYS: Colourway[] = [
  { key: 'cyan', hex: '#00F0FF' },
  { key: 'mint', hex: '#7DFFB3' },
  { key: 'lavender', hex: '#EBCFFF' },
  { key: 'pale', hex: '#DBFCFF' },
  { key: 'green', hex: '#00B347' },
  { key: 'teal', hex: '#00DBE9' },
];

const BY_KEY: Record<string, string> = Object.fromEntries(
  COLOURWAYS.map(c => [c.key, c.hex]),
);

/** Hex for a colourway key, or null if the key is unknown. */
export function colourwayHex(key: string): string | null {
  return BY_KEY[key] ?? null;
}
