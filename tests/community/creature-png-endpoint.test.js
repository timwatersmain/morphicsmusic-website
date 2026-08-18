// GET /api/community/creature/<handle>.png — the endpoint Discord embeds
// point at. Uses the same D1 shim harness as the other endpoint tests, with
// global.fetch stubbed to serve the per-sprite asset that
// scripts/build-sprite-assets.mjs writes to public/sprites/ref/.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';

import { makeD1Shim } from './helpers/d1-shim.js';
import { ensureProfile } from '../../functions/_lib/community/repo';
import {
  onRequestGet as creatureGet, resolveSize, normaliseHandle,
} from '../../functions/api/community/creature/[handle]';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = [
  // Numeric order, matching how wrangler actually applies them. This is not
  // cosmetic: 0010 REBUILDS fan_profiles with an explicit column list, so
  // applying 0011 before it silently drops `bio` and `hidden_from_wall`.
  '0002_fan_profiles', '0003_handle_locked', '0004_handle_cooldown',
  '0005_avatar_tiers', '0006_creatures', '0007_sprites', '0008_sprite_override',
  '0009_native_colourway', '0010_engagement_ep', '0011_profile_bio_privacy',
  '0012_profile_soft_delete', '0013_discord_links',
].map(n => readFileSync(join(root, `migrations/${n}.sql`), 'utf8'));

// A real sprite from the real build output — this test is worth little
// against a synthetic grid, since the point is that the vendored art
// survives the whole path.
const SPRITE = readFileSync(join(root, 'public/sprites/ref/E01.json'), 'utf8');

let raw, db, env;

beforeEach(async () => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const m of MIGRATIONS) raw.exec(m);
  db = makeD1Shim(raw);
  env = { GATES: db };

  await ensureProfile(db, {
    email: 'png@example.com', fanSince: Math.floor(Date.now() / 1000), displayName: 'Png',
  });
  raw.exec(`UPDATE fan_profiles SET handle = 'pngfan', stage = 'egg', ep = 10,
              sprite_egg = 'E01', colourway = 'jade' WHERE email = 'png@example.com'`);

  vi.stubGlobal('fetch', async (url) => {
    if (String(url).endsWith('/sprites/ref/E01.json')) {
      return new Response(SPRITE, { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('nope', { status: 404 });
  });
});

afterEach(() => vi.unstubAllGlobals());

function get(handle, query = '') {
  return creatureGet({
    request: new Request(`https://morphicsmusic.com/api/community/creature/${handle}${query}`),
    env,
    params: { handle },
  });
}

/** width/height straight out of IHDR. */
function dimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

describe('resolveSize', () => {
  it('defaults, and snaps to an integer multiple of the 32px source', () => {
    expect(resolveSize(null)).toBe(128);
    expect(resolveSize('100')).toBe(96);
    expect(resolveSize('256')).toBe(256);
    for (const input of ['1', '9999', 'abc', '-5']) {
      expect(resolveSize(input) % 32).toBe(0);
    }
  });
});

describe('normaliseHandle', () => {
  it('accepts the handle with or without a .png suffix', () => {
    expect(normaliseHandle('alice.png')).toBe('alice');
    expect(normaliseHandle('  ALICE  ')).toBe('alice');
  });
});

describe('GET /api/community/creature/<handle>', () => {
  it('returns a real PNG for a fan', async () => {
    const res = await get('pngfan.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(dimensions(bytes)).toEqual([128, 128]);
  });

  it('honours the requested size', async () => {
    const res = await get('pngfan.png', '?size=64');
    expect(dimensions(new Uint8Array(await res.arrayBuffer()))).toEqual([64, 64]);
  });

  it('draws something — not a blank canvas', async () => {
    // A silently empty image would satisfy every structural assertion above,
    // so decode the pixels and require actual ink.
    const bytes = new Uint8Array(await (await get('pngfan.png')).arrayBuffer());
    const view = new DataView(bytes.buffer);
    let p = 8;
    const idat = [];
    let width = 0;
    while (p < bytes.length) {
      const len = view.getUint32(p);
      const type = String.fromCharCode(...bytes.slice(p + 4, p + 8));
      if (type === 'IHDR') width = view.getUint32(p + 8);
      if (type === 'IDAT') idat.push(Buffer.from(bytes.slice(p + 8, p + 8 + len)));
      p += 12 + len;
    }
    const pixels = inflateSync(Buffer.concat(idat));
    const inked = Array.from(pixels).filter((b, i) => i % (width + 1) !== 0 && b !== 0);
    expect(inked.length).toBeGreaterThan(100);
  });

  it('404s for an unknown handle', async () => {
    expect((await get('nobody.png')).status).toBe(404);
  });

  it('404s for a fan hidden from the wall', async () => {
    // Otherwise this endpoint would expose a creature its owner removed.
    raw.exec(`UPDATE fan_profiles SET hidden_from_wall = 1 WHERE handle = 'pngfan'`);
    expect((await get('pngfan.png')).status).toBe(404);
  });

  it('404s rather than 500s when the profile has no sprite assigned yet', async () => {
    raw.exec(`UPDATE fan_profiles SET sprite_egg = NULL WHERE handle = 'pngfan'`);
    expect((await get('pngfan.png')).status).toBe(404);
  });

  it('leaks no account data in the response', async () => {
    const res = await get('pngfan.png');
    const headers = JSON.stringify([...res.headers]);
    expect(headers).not.toContain('png@example.com');
  });
});
