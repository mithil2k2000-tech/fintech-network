import { describe, it, expect } from "vitest";
import { MAX_LEAVES, TREE_STAGES, growTree } from "../src/modules/rewards/tree.js";

// The tree is what someone sees for their money, so the rules behind it
// get checked as carefully as the money itself: it only ever goes up,
// it never claims a stage that wasn't reached, and it can't show 100%
// of something unfinished.

const tree = (totalEarnedMinorUnits: number, rewardedPayments = 1) =>
  growTree({ totalEarnedMinorUnits, rewardedPayments });

describe("growTree", () => {
  it("starts as a seed and sprouts on the first cashback", () => {
    expect(tree(0, 0).stage).toMatchObject({ level: 0, name: "Seed" });
    expect(tree(4).stage.level).toBe(0);
    expect(tree(5).stage).toMatchObject({ level: 1, name: "Sprout" });
  });

  it("moves up exactly at each threshold, never a penny before", () => {
    for (const stage of TREE_STAGES) {
      if (stage.level === 0) continue;
      expect(tree(stage.fromMinorUnits).stage.level).toBe(stage.level);
      expect(tree(stage.fromMinorUnits - 1).stage.level).toBe(stage.level - 1);
    }
  });

  it("says how far through the current stage, floored", () => {
    // Sapling starts at 200p, Young tree at 500p: 350p is halfway.
    const half = tree(350);
    expect(half.stage.name).toBe("Sapling");
    expect(half.nextStage?.name).toBe("Young tree");
    expect(half.progressPercent).toBe(50);
    expect(half.toNextStageMinorUnits).toBe(150);

    // 499p is 99% of the way, and must not read as arrived.
    expect(tree(499).progressPercent).toBe(99);
    expect(tree(499).stage.name).toBe("Sapling");
  });

  it("is complete at the top, with nothing left to reach", () => {
    const top = TREE_STAGES[TREE_STAGES.length - 1];
    const grown = tree(top.fromMinorUnits + 10_000);
    expect(grown.stage.level).toBe(top.level);
    expect(grown.nextStage).toBeNull();
    expect(grown.progressPercent).toBe(100);
    expect(grown.toNextStageMinorUnits).toBe(0);
  });

  it("never goes backwards as more is earned", () => {
    let lastLevel = -1;
    for (let earned = 0; earned <= 6_000; earned += 7) {
      const grown = tree(earned);
      expect(grown.stage.level).toBeGreaterThanOrEqual(lastLevel);
      lastLevel = grown.stage.level;
      expect(grown.progressPercent).toBeGreaterThanOrEqual(0);
      expect(grown.progressPercent).toBeLessThanOrEqual(100);
      expect(grown.toNextStageMinorUnits).toBeGreaterThanOrEqual(0);
    }
  });

  it("draws one leaf per rewarded payment, up to a limit", () => {
    expect(tree(500, 0).leaves).toBe(0);
    expect(tree(500, 3).leaves).toBe(3);
    expect(tree(500, 99).leaves).toBe(MAX_LEAVES);
    // The real count is still reported, whatever the picture can hold.
    expect(tree(500, 99).rewardedPayments).toBe(99);
  });

  it("copes with nothing, and with nonsense, rather than showing a broken tree", () => {
    expect(tree(-100, -5).stage.level).toBe(0);
    expect(tree(-100, -5).leaves).toBe(0);
    expect(growTree({ totalEarnedMinorUnits: NaN, rewardedPayments: NaN }).stage.level).toBe(0);
  });

  it("is the same answer every time it's asked", () => {
    expect(tree(1_234, 5)).toEqual(tree(1_234, 5));
  });
});
