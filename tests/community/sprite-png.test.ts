// The hand-written PNG encoder (functions/_lib/community/sprite-png.ts).
//
// Verified against node:zlib rather than against itself: the whole risk of
// hand-writing a format is producing bytes that look plausible and that no
// real decoder accepts. These tests inflate the IDAT with a real zlib
// implementation and check the pixels that come out, and they recompute
// every chunk CRC independently.

import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { encodeIndexedPng, parseHex } from '../../functions/_lib/community/sprite-png';

const PALETTE = { '.': null, '1': '#112233', '2': '#445566', '3': '#778899', '4': '#aabbcc' };

function grid(rows: string[]): string[][] {
  return rows.map(r => r.split(''));
}

/** Walk the chunk list, verifying each CRC the way a decoder would. */
function readChunks(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Array<{ type: string; data: Uint8Array }> = [];
  let p = 8; // past the signature
  while (p < png.length) {
    const length = view.getUint32(p);
    const type = String.fromCharCode(...png.slice(p + 4, p + 8));
    const data = png.slice(p + 8, p + 8 + length);
    const declared = view.getUint32(p + 8 + length);

    // Independent CRC-32 over type+data, computed here from scratch.
    const covered = png.slice(p + 4, p + 8 + length);
    let c = 0xffffffff;
    for (const byte of covered) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    expect(((c ^ 0xffffffff) >>> 0), `CRC mismatch on ${type}`).toBe(declared);

    out.push({ type, data });
    p += 12 + length;
  }
  return out;
}

/** Decode back to palette indices per pixel, via a real inflate. */
function decodePixels(png: Uint8Array) {
  const chunks = readChunks(png);
  const ihdr = chunks.find(c => c.type === 'IHDR')!.data;
  const view = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  const width = view.getUint32(0);
  const height = view.getUint32(4);

  const idat = chunks.filter(c => c.type === 'IDAT').map(c => Buffer.from(c.data));
  const raw = inflateSync(Buffer.concat(idat));

  const rows: number[][] = [];
  let p = 0;
  for (let y = 0; y < height; y++) {
    expect(raw[p++], 'only filter type 0 is emitted').toBe(0);
    rows.push(Array.from(raw.slice(p, p + width)));
    p += width;
  }
  const plte = chunks.find(c => c.type === 'PLTE')!.data;
  return { width, height, rows, plte, chunks };
}

describe('encodeIndexedPng', () => {
  it('emits a real PNG a standard inflate can read', () => {
    const png = encodeIndexedPng(grid(['.1', '2.']), PALETTE);
    expect(Array.from(png.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const { width, height, rows } = decodePixels(png);
    expect([width, height]).toEqual([2, 2]);
    // '.' is always index 0; '1' and '2' get their own entries.
    expect(rows[0][0]).toBe(0);
    expect(rows[1][1]).toBe(0);
    expect(rows[0][1]).not.toBe(0);
    expect(rows[1][0]).not.toBe(0);
    expect(rows[0][1]).not.toBe(rows[1][0]);
  });

  it('carries the chunks a decoder requires, in order', () => {
    const { chunks } = decodePixels(encodeIndexedPng(grid(['.1']), PALETTE));
    const types = chunks.map(c => c.type);
    expect(types[0]).toBe('IHDR');
    expect(types[types.length - 1]).toBe('IEND');
    expect(types).toContain('PLTE');
    expect(types).toContain('tRNS');
  });

  it('marks only index 0 transparent', () => {
    const { chunks } = decodePixels(encodeIndexedPng(grid(['.1']), PALETTE));
    const trns = chunks.find(c => c.type === 'tRNS')!.data;
    expect(Array.from(trns)).toEqual([0]);
  });

  it('writes palette colours as the real RGB triples', () => {
    const { plte, rows } = decodePixels(encodeIndexedPng(grid(['1']), PALETTE));
    const idx = rows[0][0];
    expect(Array.from(plte.slice(idx * 3, idx * 3 + 3))).toEqual([0x11, 0x22, 0x33]);
  });

  it('scales by nearest neighbour, never interpolating', () => {
    // Pixel art at a fractional scale or with smoothing is ruined — every
    // output pixel must be an exact copy of a source pixel.
    const png = encodeIndexedPng(grid(['.1', '2.']), PALETTE, { scale: 4 });
    const { width, height, rows } = decodePixels(png);
    expect([width, height]).toEqual([8, 8]);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const src = rows[Math.floor(y / 4) * 4][Math.floor(x / 4) * 4];
        expect(rows[y][x]).toBe(src);
      }
    }
  });

  it('handles a grid larger than one deflate stored block', () => {
    // A stored block caps at 65535 bytes; a 32x32 sprite at scale 8 exceeds
    // that, so the block-splitting loop has to be right.
    const rows = Array.from({ length: 32 }, () => '1'.repeat(32));
    const png = encodeIndexedPng(grid(rows), PALETTE, { scale: 8 });
    const decoded = decodePixels(png);
    expect([decoded.width, decoded.height]).toEqual([256, 256]);
    expect(decoded.rows.length).toBe(256);
    expect(new Set(decoded.rows[0]).size).toBe(1);
  });

  it('survives an empty grid rather than emitting corrupt bytes', () => {
    const png = encodeIndexedPng([], PALETTE);
    expect(() => readChunks(png)).not.toThrow();
  });
});

describe('parseHex', () => {
  it('parses with and without the hash', () => {
    expect(parseHex('#ff8800')).toEqual([255, 136, 0]);
    expect(parseHex('ff8800')).toEqual([255, 136, 0]);
  });

  it('falls back to black instead of throwing on junk', () => {
    // A malformed colourway must not 500 an image request.
    expect(parseHex('not-a-colour')).toEqual([0, 0, 0]);
    expect(parseHex('')).toEqual([0, 0, 0]);
  });
});
