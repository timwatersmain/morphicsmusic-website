import { describe, it, expect } from 'vitest';
import { computeStageProgress, rankLadder, STAGE_ORDER, STAGE_LABELS } from '../../src/scripts/community/xp-progress';
import { STAGE_THRESHOLDS } from '../../functions/_lib/community/ep';

describe('computeStageProgress', () => {
  it('lower boundary: fill is 0 right at the start of a stage band', () => {
    const p = computeStageProgress({ ep: STAGE_THRESHOLDS.grub, stage: 'grub', next_stage_ep: STAGE_THRESHOLDS.pupa });
    expect(p.pct).toBe(0);
    expect(p.isFinal).toBe(false);
    expect(p.stageLabel).toBe('Grub');
    expect(p.nextLabel).toBe('Pupa');
    expect(p.epInStage).toBe(0);
    expect(p.epForStage).toBe(STAGE_THRESHOLDS.pupa - STAGE_THRESHOLDS.grub);
  });

  it('mid-band: fill sits at the halfway point of the band, not of raw EP', () => {
    const mid = Math.floor((STAGE_THRESHOLDS.grub + STAGE_THRESHOLDS.pupa) / 2);
    const p = computeStageProgress({ ep: mid, stage: 'grub', next_stage_ep: STAGE_THRESHOLDS.pupa });
    expect(p.pct).toBeCloseTo(50, 0);
  });

  it('upper boundary: fill reaches (but does not exceed) 100 right at the next threshold', () => {
    const p = computeStageProgress({ ep: STAGE_THRESHOLDS.pupa, stage: 'grub', next_stage_ep: STAGE_THRESHOLDS.pupa });
    expect(p.pct).toBe(100);
    expect(p.epInStage).toBe(p.epForStage);
  });

  it('someone deep in a later band does not read as "almost done" from raw EP alone', () => {
    // 900 EP against a 1000-style total would look nearly full; here it's
    // partway into pupa's own band (200..600), which is the whole point.
    const p = computeStageProgress({ ep: 480, stage: 'pupa', next_stage_ep: STAGE_THRESHOLDS.adult });
    expect(p.pct).toBeLessThan(90);
  });

  it('final stage returns a completed state instead of dividing by a missing threshold', () => {
    const p = computeStageProgress({ ep: 700, stage: 'adult', next_stage_ep: null });
    expect(p.isFinal).toBe(true);
    expect(p.pct).toBe(100);
    expect(p.nextStage).toBeNull();
    expect(p.nextLabel).toBeNull();
    expect(p.epForStage).toBeNull();
    expect(() => computeStageProgress({ ep: 700, stage: 'adult', next_stage_ep: null })).not.toThrow();
  });

  it('EP far above the final threshold still does not produce over-100% fill', () => {
    const p = computeStageProgress({ ep: 999999, stage: 'adult', next_stage_ep: null });
    expect(p.pct).toBe(100);
    expect(p.pct).toBeLessThanOrEqual(100);
  });

  it('egg at zero EP is a valid lower boundary, not an error state', () => {
    const p = computeStageProgress({ ep: 0, stage: 'egg', next_stage_ep: STAGE_THRESHOLDS.grub });
    expect(p.pct).toBe(0);
    expect(p.epInStage).toBe(0);
    expect(p.epForStage).toBe(STAGE_THRESHOLDS.grub);
  });
});

describe('rankLadder', () => {
  it('egg with nothing passed yet: current is loud, the rest are ahead', () => {
    const ladder = rankLadder('egg');
    expect(ladder.map(s => s.status)).toEqual(['current', 'ahead', 'ahead', 'ahead']);
    expect(ladder.map(s => s.label)).toEqual(['Egg', 'Grub', 'Pupa', 'Adult']);
  });

  it('mid-ladder: earlier stages passed, one current, later ones ahead', () => {
    const ladder = rankLadder('pupa');
    expect(ladder.map(s => s.status)).toEqual(['passed', 'passed', 'current', 'ahead']);
  });

  it('final stage: everything before it passed, it is current, nothing is ahead', () => {
    const ladder = rankLadder('adult');
    expect(ladder.map(s => s.status)).toEqual(['passed', 'passed', 'passed', 'current']);
    expect(ladder.some(s => s.status === 'ahead')).toBe(false);
  });

  it('always covers all four stages in order', () => {
    expect(rankLadder('grub').map(s => s.stage)).toEqual(STAGE_ORDER);
  });

  it('reuses the same STAGE_LABELS the fan wall imports, so the two can never drift', () => {
    expect(STAGE_LABELS).toEqual({ egg: 'Egg', grub: 'Grub', pupa: 'Pupa', adult: 'Adult' });
  });
});
