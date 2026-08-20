import { describe, it, expect } from 'vitest';
import { computeStageProgress, rankLadder, STAGE_ORDER, STAGE_LABELS, MILESTONE_STEP, rankLabelFor } from '../../src/scripts/community/xp-progress';
import { STAGE_THRESHOLDS } from '../../functions/_lib/community/ep';

describe('computeStageProgress', () => {
  it('lower boundary: fill is 0 right at the start of a stage band', () => {
    const p = computeStageProgress({ ep: STAGE_THRESHOLDS.grub, stage: 'grub', next_stage_ep: STAGE_THRESHOLDS.pupa });
    expect(p.pct).toBe(0);
    expect(p.isFinal).toBe(false);
    expect(p.stageLabel).toBe('Larva');
    expect(p.nextLabel).toBe('Chrysalis');
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

  it('final stage keeps earning: no next stage, but a live milestone band instead of a dead 100%', () => {
    const ep = STAGE_THRESHOLDS.adult + 100;
    const p = computeStageProgress({ ep, stage: 'adult', next_stage_ep: null });
    expect(p.isFinal).toBe(true);
    expect(p.nextStage).toBeNull();
    expect(p.nextLabel).toBeNull();
    expect(p.epForStage).toBeNull();
    expect(p.milestone).not.toBeNull();
    expect(p.milestone!.index).toBe(1);
    expect(p.milestone!.epInto).toBe(100);
    expect(p.milestone!.epRemaining).toBe(MILESTONE_STEP - 100);
    expect(p.milestone!.target).toBe(STAGE_THRESHOLDS.adult + MILESTONE_STEP);
    expect(p.pct).toBeCloseTo((100 / MILESTONE_STEP) * 100, 5);
  });

  it('an Emergent fan who earns more moves the bar — it does not sit pinned', () => {
    const a = computeStageProgress({ ep: STAGE_THRESHOLDS.adult + 10, stage: 'adult', next_stage_ep: null });
    const b = computeStageProgress({ ep: STAGE_THRESHOLDS.adult + 200, stage: 'adult', next_stage_ep: null });
    expect(b.pct).toBeGreaterThan(a.pct);
    expect(b.totalEp).toBeGreaterThan(a.totalEp);
  });

  it('milestones roll over rather than overflowing past 100% fill', () => {
    const p = computeStageProgress({ ep: STAGE_THRESHOLDS.adult + MILESTONE_STEP * 3 + 5, stage: 'adult', next_stage_ep: null });
    expect(p.milestone!.index).toBe(4);
    expect(p.milestone!.epInto).toBe(5);
    expect(p.pct).toBeLessThanOrEqual(100);
    expect(p.pct).toBeGreaterThanOrEqual(0);
  });

  it('totalEp is the raw lifetime figure at every stage, never re-based to a band', () => {
    const mid = computeStageProgress({ ep: 480, stage: 'pupa', next_stage_ep: STAGE_THRESHOLDS.adult });
    expect(mid.totalEp).toBe(480);
    expect(mid.epInStage).toBe(480 - STAGE_THRESHOLDS.pupa);
    const top = computeStageProgress({ ep: 999999, stage: 'adult', next_stage_ep: null });
    expect(top.totalEp).toBe(999999);
    expect(top.pct).toBeLessThanOrEqual(100);
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
    expect(ladder.map(s => s.label)).toEqual(['Egg', 'Larva', 'Chrysalis', 'Emergent']);
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

  it('each rung states the lifetime XP it costs to reach, straight from STAGE_THRESHOLDS', () => {
    expect(rankLadder('egg').map(s => s.requiredEp)).toEqual([
      0,
      STAGE_THRESHOLDS.grub,
      STAGE_THRESHOLDS.pupa,
      STAGE_THRESHOLDS.adult,
    ]);
  });

  it('reuses the same STAGE_LABELS the fan wall imports, so the two can never drift', () => {
    expect(STAGE_LABELS).toEqual({ egg: 'Egg', grub: 'Larva', pupa: 'Chrysalis', adult: 'Emergent' });
  });
});

describe('artist rank', () => {
  it('prints Morphics for the artist handle, at any stage', () => {
    // The artist is stored as a normal 'adult' and keeps earning normally —
    // only the printed word differs, so every stage must map to the name.
    for (const stage of STAGE_ORDER) {
      expect(rankLabelFor(stage, 'morphics')).toBe('Morphics');
    }
  });

  it('is case-insensitive on the handle', () => {
    expect(rankLabelFor('adult', 'MORPHICS')).toBe('Morphics');
    expect(rankLabelFor('adult', 'Morphics')).toBe('Morphics');
  });

  it('gives every other fan the ordinary ladder word', () => {
    // Including handles that merely CONTAIN the artist's, which is the
    // impersonation an over-eager substring check would hand out for free.
    for (const handle of ['someone', 'morphicsmusic', 'morphics-fan', 'notmorphics', '']) {
      expect(rankLabelFor('adult', handle)).toBe(STAGE_LABELS.adult);
      expect(rankLabelFor('egg', handle)).toBe(STAGE_LABELS.egg);
    }
  });

  it('falls back to the stage word when no handle is known', () => {
    expect(rankLabelFor('pupa')).toBe(STAGE_LABELS.pupa);
    expect(rankLabelFor('pupa', null)).toBe(STAGE_LABELS.pupa);
  });

  it('does not disturb the stage ladder itself', () => {
    // The ladder measures progress and must stay identical for everyone —
    // the artist's rank is a name shown INSTEAD of the current rung, not a
    // fifth rung spliced into the path fans climb.
    expect(rankLadder('adult').map(s => s.label))
      .toEqual([STAGE_LABELS.egg, STAGE_LABELS.grub, STAGE_LABELS.pupa, STAGE_LABELS.adult]);
  });
});
