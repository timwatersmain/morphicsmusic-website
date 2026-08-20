// Pure display helpers for the XP bar + rank ladder on /community/me. No
// fetch, no DOM — the page's own script owns wiring this into elements.
//
// Uses STAGE_LABELS and STAGE_THRESHOLDS as exported (read-only) from
// functions/_lib/community/ep.ts — the EP model itself is never touched by
// this file, only consulted. Importing STAGE_LABELS (rather than declaring a
// second copy here) is also why the fan wall (src/pages/community/index.astro)
// and this page can never drift onto two different sets of stage names.
import { STAGE_LABELS, STAGE_THRESHOLDS, rankLabelFor, type CreatureStage } from '../../../functions/_lib/community/ep';

export { STAGE_LABELS, rankLabelFor };
export type { CreatureStage };

// Low to high — the ladder is always rendered in this order regardless of
// where the fan currently is.
export const STAGE_ORDER: CreatureStage[] = ['egg', 'grub', 'pupa', 'adult'];

export type RankStatus = 'passed' | 'current' | 'ahead';

export interface RankLadderStep {
  stage: CreatureStage;
  label: string;
  status: RankStatus;
  /** Lifetime EP needed to reach this stage. 0 for egg — everyone starts there. */
  requiredEp: number;
}

/**
 * The full four-stage ladder with each stage classified relative to
 * `currentStage`. Every stage is always present — including the ones ahead
 * of the fan — because an invisible path motivates nobody (that's the whole
 * point of this section per the brief). At the top stage ('adult') there are
 * never any 'ahead' entries; that is not a bug, it's what "nothing left to
 * reach" looks like.
 */
export function rankLadder(currentStage: CreatureStage): RankLadderStep[] {
  const idx = STAGE_ORDER.indexOf(currentStage);
  const currentIdx = idx === -1 ? 0 : idx; // unknown/legacy stage reads as egg
  return STAGE_ORDER.map((stage, i) => ({
    stage,
    label: STAGE_LABELS[stage],
    status: i < currentIdx ? 'passed' : i === currentIdx ? 'current' : 'ahead',
    // Carried on the step itself so the ladder can state its own entry
    // price — "Chrysalis, 200 XP" — instead of a fan having to guess what
    // the stage ahead of them actually costs.
    requiredEp: stage === 'egg' ? 0 : STAGE_THRESHOLDS[stage],
  }));
}

// EP at which a fan ENTERS `stage` — 'egg' starts the whole ladder at 0, and
// every other stage's entry point is exactly the threshold that was crossed
// to reach it (STAGE_THRESHOLDS is keyed by "threshold to REACH this stage",
// so reading it back for the stage itself gives its own band's start for free
// — no separate table, no re-derivation of the thresholds themselves).
function bandStart(stage: CreatureStage): number {
  return stage === 'egg' ? 0 : STAGE_THRESHOLDS[stage];
}

export interface CreatureProgressInput {
  ep: number;
  stage: CreatureStage;
  /** Absolute EP needed to reach the NEXT stage, or null at the top stage. */
  next_stage_ep: number | null;
}

/**
 * Once a fan is Emergent there is no fifth stage to climb to, but EP keeps
 * accruing (tenure alone guarantees it) and a bar pinned at 100% forever
 * hides that. Past the top threshold the bar therefore measures progress
 * toward the next MILESTONE — a repeating band the same width as the
 * pupa->adult one, so the pace of the bar never changes at the moment a fan
 * emerges. Milestones are a display concept only: nothing server-side reads
 * them, no stage or sprite changes, and the rank stays Emergent forever.
 */
export const MILESTONE_STEP = STAGE_THRESHOLDS.adult - STAGE_THRESHOLDS.pupa;

export interface Milestone {
  /** 1-based: the first milestone after emerging is 1. */
  index: number;
  /** Absolute EP total at which this milestone is reached. */
  target: number;
  /** EP earned into the current milestone band (0..width). */
  epInto: number;
  /** Width of a milestone band — constant, but returned so callers never re-derive it. */
  width: number;
  /** EP still to go. */
  epRemaining: number;
}

export interface StageProgress {
  stage: CreatureStage;
  stageLabel: string;
  /** null at the final stage — there is nothing after it. */
  nextStage: CreatureStage | null;
  nextLabel: string | null;
  /** 0..100 fill for the bar — progress within THIS stage's band, never raw EP against a fixed total. */
  pct: number;
  isFinal: boolean;
  /** EP earned since entering the current stage (0 at the band's lower boundary). */
  epInStage: number;
  /** Width of the current stage's band — "EP needed" for display. null at the final stage. */
  epForStage: number | null;
  /** Lifetime EP total, exactly as stored — never re-based to a stage band. */
  totalEp: number;
  /** Only set at the final stage: the repeating post-Emergent band the bar tracks. */
  milestone: Milestone | null;
}

/**
 * Turns one creature payload into everything the rank section needs to
 * render. Deliberately re-based to the CURRENT stage's own band (via
 * bandStart) rather than using raw EP against `next_stage_ep` directly —
 * that's what keeps someone at, say, 900 EP with a 1000 threshold from
 * reading as "almost done" and then appearing to reset the moment they
 * evolve and the next band starts back at a low percentage.
 *
 * Never divides by `next_stage_ep` when it's null (the top stage): that
 * naive `ep / next_stage_ep` is exactly the "empty or broken rectangle"
 * failure mode the brief calls out, so the final stage branches off before
 * any division happens and fills across a milestone band instead (see
 * MILESTONE_STEP) — Emergent keeps earning, so the bar keeps moving.
 *
 * `totalEp` is always the raw lifetime total, at every stage, so a surface
 * can show "what you've earned in all" alongside "where that puts you"
 * without doing arithmetic of its own.
 */
export function computeStageProgress(input: CreatureProgressInput): StageProgress {
  const stage = input.stage;
  const idx = STAGE_ORDER.indexOf(stage);
  const isFinal = input.next_stage_ep === null;
  const nextStage = isFinal ? null : (STAGE_ORDER[idx + 1] ?? null);
  const ep = Math.max(0, Number(input.ep) || 0);
  const start = bandStart(stage);
  const epInStage = Math.max(0, ep - start);

  if (isFinal) {
    // Keep the bar alive past the top of the ladder: it now fills across a
    // repeating milestone band instead of sitting pinned at 100% for good.
    const index = Math.floor(epInStage / MILESTONE_STEP) + 1;
    const epInto = epInStage % MILESTONE_STEP;
    return {
      stage,
      stageLabel: STAGE_LABELS[stage],
      nextStage: null,
      nextLabel: null,
      pct: (epInto / MILESTONE_STEP) * 100,
      isFinal: true,
      epInStage,
      epForStage: null,
      totalEp: ep,
      milestone: {
        index,
        target: start + index * MILESTONE_STEP,
        epInto,
        width: MILESTONE_STEP,
        epRemaining: MILESTONE_STEP - epInto,
      },
    };
  }

  const width = Math.max(1, (input.next_stage_ep as number) - start);
  const pct = Math.max(0, Math.min(100, (epInStage / width) * 100));
  return {
    stage,
    stageLabel: STAGE_LABELS[stage],
    nextStage,
    nextLabel: nextStage ? STAGE_LABELS[nextStage] : null,
    pct,
    isFinal: false,
    epInStage: Math.min(epInStage, width),
    epForStage: width,
    totalEp: ep,
    milestone: null,
  };
}
