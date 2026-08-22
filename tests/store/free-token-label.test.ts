import { describe, it, expect } from 'vitest';
import manifest from '../../src/data/masters-manifest.json';

// The endpoint sends KEYS and shows LABELS. Only the label is derived, so
// only the label can be wrong — and the worst it can be is ugly, never the
// wrong file. This pins that it stays readable across the catalogue's very
// inconsistent master filenames.
function prettyName(filename: string): string {
  return filename
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/^Morphics\s*[-–—]\s*/i, '')
    .replace(/^Morphics(?=[A-Z0-9])/, '')
    .replace(/\s*\(\d+\)$/, '')
    .replace(/\s+\d+$/, '')
    .trim() || filename;
}

describe('free-track labels', () => {
  it('strips the artist prefix and extension in every naming style present', () => {
    expect(prettyName('Morphics - Eartoy.wav')).toBe('Eartoy');
    expect(prettyName('MorphicsThe6thSense.wav')).toBe('The6thSense');
    expect(prettyName('Morphics - Blindly 6.wav')).toBe('Blindly');
    expect(prettyName('MorphicsMelliflous (1).aif')).toBe('Melliflous');
    expect(prettyName('01 Synaptic Acid.wav')).toBe('01 Synaptic Acid');
  });

  it('never returns an empty label for anything in the shipped manifest', () => {
    // An empty <option> is an unpickable track.
    const files = Object.values((manifest as any).releases).flat() as any[];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(prettyName(f.filename).length, f.filename).toBeGreaterThan(0);
    }
  });

  it('keeps labels distinct within each release, so two options are never identical', () => {
    for (const [slug, files] of Object.entries((manifest as any).releases) as any) {
      const labels = files.map((f: any) => prettyName(f.filename));
      expect(new Set(labels).size, `${slug} has duplicate labels: ${labels.join(', ')}`).toBe(labels.length);
    }
  });
});
