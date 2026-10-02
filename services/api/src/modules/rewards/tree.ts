// The rewards tree: a picture of what someone has earned.
//
// It is DERIVED, never stored. Every stage and every percentage below
// is worked out from cashback grants, which are immutable and already
// tied to ledger entries — so the tree can never drift from the money,
// and there is no second score to keep in step (or to go wrong).
//
// It is also only a picture: no real tree is planted, nothing is
// donated, and the app must not suggest otherwise.
import type { MinorUnits } from "@fintech-network/shared-types";

export interface TreeStage {
  /** 0 upwards, so a client can compare without parsing names. */
  level: number;
  name: string;
  /** Total cashback, in pence, that reaches this stage. */
  fromMinorUnits: MinorUnits;
}

/**
 * Deliberately gentle at the start: the first step is one £5 shop
 * payment, so the tree does something on day one instead of looking
 * broken. Thresholds live here and nowhere else — the app reads them
 * from the API rather than repeating them.
 */
export const TREE_STAGES: readonly TreeStage[] = [
  { level: 0, name: "Seed", fromMinorUnits: 0 },
  { level: 1, name: "Sprout", fromMinorUnits: 5 },
  { level: 2, name: "Seedling", fromMinorUnits: 50 },
  { level: 3, name: "Sapling", fromMinorUnits: 200 },
  { level: 4, name: "Young tree", fromMinorUnits: 500 },
  { level: 5, name: "Tree", fromMinorUnits: 1_500 },
  { level: 6, name: "Old oak", fromMinorUnits: 5_000 },
] as const;

/** The most leaves the picture draws, however much is earned. */
export const MAX_LEAVES = 12;

export interface RewardsTree {
  stage: TreeStage;
  /** The next one to reach, or null at the top. */
  nextStage: TreeStage | null;
  totalEarnedMinorUnits: MinorUnits;
  /** How far into the current stage, 0–100, floored. 100 at the top. */
  progressPercent: number;
  /** What's still needed for the next stage; 0 at the top. */
  toNextStageMinorUnits: MinorUnits;
  /** One leaf per payment that earned something, capped for the drawing. */
  leaves: number;
  rewardedPayments: number;
}

export interface TreeInput {
  totalEarnedMinorUnits: MinorUnits;
  rewardedPayments: number;
}

function stageFor(totalEarnedMinorUnits: MinorUnits): TreeStage {
  let current = TREE_STAGES[0];
  for (const stage of TREE_STAGES) {
    if (totalEarnedMinorUnits >= stage.fromMinorUnits) current = stage;
  }
  return current;
}

/**
 * Works the whole tree out from two numbers. Pure, so what someone sees
 * can be reasoned about without a database — and so the thresholds can
 * change in one place without touching a screen.
 */
export function growTree(input: TreeInput): RewardsTree {
  const total = Math.max(0, Math.floor(input.totalEarnedMinorUnits || 0));
  const rewardedPayments = Math.max(0, Math.floor(input.rewardedPayments || 0));

  const stage = stageFor(total);
  const nextStage = TREE_STAGES[stage.level + 1] ?? null;

  // At the top there's nothing left to fill, so it reads as complete
  // rather than as a bar stuck at some arbitrary fraction.
  if (!nextStage) {
    return {
      stage,
      nextStage: null,
      totalEarnedMinorUnits: total,
      progressPercent: 100,
      toNextStageMinorUnits: 0,
      leaves: Math.min(rewardedPayments, MAX_LEAVES),
      rewardedPayments,
    };
  }

  const span = nextStage.fromMinorUnits - stage.fromMinorUnits;
  const into = total - stage.fromMinorUnits;
  // Integer percentages, floored: never round up to 100 before it's true.
  const progressPercent = span > 0 ? Math.min(99, Math.floor((into * 100) / span)) : 0;

  return {
    stage,
    nextStage,
    totalEarnedMinorUnits: total,
    progressPercent,
    toNextStageMinorUnits: nextStage.fromMinorUnits - total,
    leaves: Math.min(rewardedPayments, MAX_LEAVES),
    rewardedPayments,
  };
}
