// Unit tests for functions/_lib/password.ts — the peppered PBKDF2 scheme
// backing username/password login. Money-path files and the existing
// magic-link auth.ts are untouched by this feature; these tests only cover
// the new hashing module.

import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../functions/_lib/password';

const env = { PASSWORD_PEPPER: 'test-only-pepper-not-real-do-not-use', PASSWORD_KDF_ITERATIONS: '1000' };

describe('hashPassword / verifyPassword', () => {
  it('correct password verifies', async () => {
    const hash = await hashPassword(env, 'correct horse battery staple');
    const result = await verifyPassword(env, 'correct horse battery staple', hash);
    expect(result.ok).toBe(true);
  });

  it('wrong password fails', async () => {
    const hash = await hashPassword(env, 'correct horse battery staple');
    const result = await verifyPassword(env, 'wrong password entirely', hash);
    expect(result.ok).toBe(false);
  });

  it('the same password hashes differently each time (random salt)', async () => {
    const a = await hashPassword(env, 'same password twice');
    const b = await hashPassword(env, 'same password twice');
    expect(a).not.toBe(b);
    expect((await verifyPassword(env, 'same password twice', a)).ok).toBe(true);
    expect((await verifyPassword(env, 'same password twice', b)).ok).toBe(true);
  });

  it('a hash made at a lower iteration count still verifies and reports needsRehash', async () => {
    const lowEnv = { ...env, PASSWORD_KDF_ITERATIONS: '500' };
    const hash = await hashPassword(lowEnv, 'legacy iteration password');
    const higherEnv = { ...env, PASSWORD_KDF_ITERATIONS: '1000' };
    const result = await verifyPassword(higherEnv, 'legacy iteration password', hash);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(true);
  });

  it('a hash at the current iteration count does not need rehash', async () => {
    const hash = await hashPassword(env, 'current iteration password');
    const result = await verifyPassword(env, 'current iteration password', hash);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(false);
  });

  it('a missing pepper throws rather than returning a weak hash', async () => {
    const noPepperEnv = { PASSWORD_PEPPER: '' };
    await expect(hashPassword(noPepperEnv as any, 'anything')).rejects.toThrow();
  });

  it('a short pepper also throws (fail closed, not just empty-string check)', async () => {
    const shortPepperEnv = { PASSWORD_PEPPER: 'short' };
    await expect(hashPassword(shortPepperEnv as any, 'anything')).rejects.toThrow();
  });

  it('a tampered stored string fails', async () => {
    const hash = await hashPassword(env, 'tamper test password');
    const parts = hash.split('$');
    // Flip a character in the hash segment.
    const tamperedHashSeg = parts[4].slice(0, -1) + (parts[4].slice(-1) === 'A' ? 'B' : 'A');
    const tampered = [parts[0], parts[1], parts[2], parts[3], tamperedHashSeg].join('$');
    const result = await verifyPassword(env, 'tamper test password', tampered);
    expect(result.ok).toBe(false);
  });

  it('garbage stored strings fail closed rather than throwing', async () => {
    const result = await verifyPassword(env, 'anything', 'not-a-real-stored-hash');
    expect(result.ok).toBe(false);
  });

  it('clamps an absurd configured iteration count (C6)', async () => {
    const hugeEnv = { ...env, PASSWORD_KDF_ITERATIONS: '99999999' };
    const hash = await hashPassword(hugeEnv, 'clamp test password');
    const parts = hash.split('$');
    expect(parseInt(parts[2], 10)).toBeLessThanOrEqual(200000);
  });
});
