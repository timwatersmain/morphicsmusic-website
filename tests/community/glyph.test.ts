import { describe, it, expect } from 'vitest';
import { glyphLetterFor } from '../../functions/_lib/community/glyph';

describe('glyphLetterFor', () => {
  it('uses the first letter of a plain username', () => {
    expect(glyphLetterFor('skratchwax')).toBe('s');
  });

  it('skips leading digits', () => {
    expect(glyphLetterFor('808state')).toBe('s');
  });

  it('skips leading symbols', () => {
    expect(glyphLetterFor('_-morphics')).toBe('m');
  });

  it('falls back to the house letter m when there is no letter at all', () => {
    expect(glyphLetterFor('808_909')).toBe('m');
  });

  it('lowercases uppercase input', () => {
    expect(glyphLetterFor('MORPHICS')).toBe('m');
  });

  it('is consistent for the same username', () => {
    expect(glyphLetterFor('ana')).toBe(glyphLetterFor('ana'));
  });
});
