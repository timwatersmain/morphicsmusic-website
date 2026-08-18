// A minimal PNG encoder, so a creature can be rendered server-side.
//
// WHY THIS EXISTS: the site draws creatures on a <canvas> in the browser
// (src/scripts/sprites/renderer.js). Workers have no canvas and no image
// library, but Discord needs a URL that returns a real image. Rather than
// add a dependency or ship a WASM decoder, this writes the PNG bytes
// directly — which is tractable here precisely because the source art is
// 32x32 with at most 5 colours.
//
// INDEXED COLOUR (type 3), not RGBA (type 6), for that reason: one byte per
// pixel instead of four. At 4x scale that is 16KB of pixel data rather than
// 65KB, and since this is emitted uncompressed (see deflateStored) the
// difference lands directly in the response size.
//
// The output is deliberately NOT compressed with a real deflate: stored
// blocks are a valid, spec-compliant zlib stream, and implementing LZ77 +
// Huffman here to save a few KB on an image this small would be a lot of
// subtle code for no benefit a CDN cache does not already provide.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Standard PNG CRC-32 (IEEE 802.3 polynomial, reflected). Table built once
// per isolate, not per call.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Adler-32, the checksum a zlib stream ends with. */
function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(type: string, data: number[]): number[] {
  const typeAndData = [...type.split('').map(ch => ch.charCodeAt(0)), ...data];
  return [...u32(data.length), ...typeAndData, ...u32(crc32(new Uint8Array(typeAndData)))];
}

/**
 * Wrap raw bytes in a zlib stream using STORED (uncompressed) deflate
 * blocks. Each block carries at most 65535 bytes, so anything larger is
 * split — a 4x-scaled sprite is 16KB and fits in one, but the loop is
 * required for correctness at larger scales rather than a hypothetical.
 */
function deflateStored(raw: Uint8Array): number[] {
  const out: number[] = [0x78, 0x01]; // zlib header: deflate, 32K window, no dict
  const MAX = 0xffff;
  if (raw.length === 0) {
    out.push(0x01, 0x00, 0x00, 0xff, 0xff);
  }
  for (let offset = 0; offset < raw.length; offset += MAX) {
    const len = Math.min(MAX, raw.length - offset);
    const isLast = offset + len >= raw.length;
    out.push(isLast ? 1 : 0);
    // LEN then its one's complement, both little-endian.
    out.push(len & 0xff, (len >>> 8) & 0xff);
    out.push(~len & 0xff, (~len >>> 8) & 0xff);
    for (let i = 0; i < len; i++) out.push(raw[offset + i]);
  }
  out.push(...u32(adler32(raw)));
  return out;
}

/** '#rrggbb' -> [r, g, b]. Bad input renders as black rather than throwing. */
export function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export interface PngOptions {
  /** Integer nearest-neighbour scale. Pixel art at a fractional scale blurs. */
  scale?: number;
}

/**
 * Encode a grid of palette keys as an indexed PNG.
 *
 * `grid` is rows of single-character keys ('.', '1'..'4') exactly as the
 * vendored sprite format stores them; `palette` maps those keys to a hex
 * colour, or null for transparent (see vendor/colorways.js's paletteOf).
 *
 * Palette index 0 is always the transparent entry, so tRNS only ever needs
 * to describe one entry — every other colour is fully opaque.
 */
export function encodeIndexedPng(
  grid: string[][],
  palette: Record<string, string | null>,
  options: PngOptions = {},
): Uint8Array {
  const scale = Math.max(1, Math.floor(options.scale || 1));
  const height = grid.length;
  const width = height ? grid[0].length : 0;

  // Index 0 is transparent; the rest are assigned in first-seen order so the
  // palette never carries entries the image does not use.
  const indexByKey = new Map<string, number>([['.', 0]]);
  const plte: number[] = [0, 0, 0];
  for (const [key, colour] of Object.entries(palette)) {
    if (key === '.' || colour === null || colour === undefined) continue;
    if (indexByKey.has(key)) continue;
    indexByKey.set(key, plte.length / 3);
    plte.push(...parseHex(colour));
  }

  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  // One filter byte (0 = None) per scanline, then one index byte per pixel.
  const raw = new Uint8Array(scaledHeight * (scaledWidth + 1));
  let p = 0;
  for (let y = 0; y < scaledHeight; y++) {
    raw[p++] = 0;
    const row = grid[Math.floor(y / scale)];
    for (let x = 0; x < scaledWidth; x++) {
      const key = row ? row[Math.floor(x / scale)] : '.';
      raw[p++] = indexByKey.get(key) ?? 0;
    }
  }

  const bytes = [
    ...PNG_SIGNATURE,
    ...chunk('IHDR', [
      ...u32(scaledWidth), ...u32(scaledHeight),
      8,  // bit depth
      3,  // colour type: indexed
      0, 0, 0, // compression, filter, interlace — all the only legal value
    ]),
    ...chunk('PLTE', plte),
    // Only index 0 is transparent. tRNS may be shorter than PLTE; entries it
    // does not mention are fully opaque, which is exactly what we want.
    ...chunk('tRNS', [0]),
    ...chunk('IDAT', deflateStored(raw)),
    ...chunk('IEND', []),
  ];
  return new Uint8Array(bytes);
}
