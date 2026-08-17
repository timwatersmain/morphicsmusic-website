import { describe, it, expect } from 'vitest';
import { clientValidate, describeSetPasswordError, USERNAME_RE, MIN_PASSWORD } from '../../src/scripts/account-setup.js';

describe('clientValidate', () => {
  it('accepts a valid username/password pair', () => {
    expect(clientValidate({ username: 'good_name-1', password: '1234567890', confirm: '1234567890' })).toBeNull();
  });

  it('rejects a too-short username', () => {
    expect(clientValidate({ username: 'ab', password: '1234567890', confirm: '1234567890' })).toMatch(/3-24/);
  });

  it('rejects disallowed characters', () => {
    expect(clientValidate({ username: 'Not Valid!', password: '1234567890', confirm: '1234567890' })).toMatch(/3-24/);
  });

  it('rejects a too-short password', () => {
    expect(clientValidate({ username: 'gooduser', password: 'short1', confirm: 'short1' })).toMatch(new RegExp(String(MIN_PASSWORD)));
  });

  it('rejects mismatched confirm', () => {
    expect(clientValidate({ username: 'gooduser', password: '1234567890', confirm: '0987654321' })).toMatch(/match/);
  });

  it('USERNAME_RE matches the server rule exactly', () => {
    expect(USERNAME_RE.source).toBe('^[a-z0-9_-]{3,24}$');
  });
});

describe('describeSetPasswordError', () => {
  it('maps "current password required" to actionable copy', () => {
    const msg = describeSetPasswordError(401, { error: 'current password required' });
    expect(msg).toMatch(/current password/i);
  });

  it('maps "current password incorrect" distinctly from "required"', () => {
    const required = describeSetPasswordError(401, { error: 'current password required' });
    const incorrect = describeSetPasswordError(401, { error: 'current password incorrect' });
    expect(incorrect).not.toBe(required);
    expect(incorrect).toMatch(/incorrect/i);
  });

  it('maps a taken/blocked username to actionable copy', () => {
    const msg = describeSetPasswordError(400, { error: 'that username is not available' });
    expect(msg).toMatch(/taken|reserved/i);
  });

  it('maps username format errors distinctly from taken/blocked', () => {
    const format = describeSetPasswordError(400, { error: 'username must be 3-24 characters: a-z, 0-9, underscore, hyphen' });
    const taken = describeSetPasswordError(400, { error: 'that username is not available' });
    expect(format).not.toBe(taken);
  });

  it('maps password-too-short distinctly from mismatch', () => {
    const short = describeSetPasswordError(400, { error: 'password must be at least 10 characters' });
    const mismatch = describeSetPasswordError(400, { error: 'passwords do not match' });
    expect(short).not.toBe(mismatch);
  });

  it('maps rate limiting to its own message', () => {
    expect(describeSetPasswordError(429, {})).toMatch(/too many|wait/i);
  });

  it('falls back to a generic message for an unrecognized shape', () => {
    expect(describeSetPasswordError(500, {})).toMatch(/could not save/i);
  });
});
