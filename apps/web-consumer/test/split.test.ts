import { describe, it, expect } from "vitest";
import { previewShares, previewSplit } from "../src/lib/split";

// The preview has to agree with the server, or the screen promises one
// thing and the requests say another. These are the same examples the
// API's own split tests use (services/api/test/billSplits.unit.test.ts).

describe("previewShares", () => {
  it("matches the server's answers", () => {
    expect(previewShares(6_000, 4)).toEqual([1_500, 1_500, 1_500, 1_500]);
    expect(previewShares(1_000, 3)).toEqual([334, 333, 333]);
    expect(previewShares(1_001, 3)).toEqual([334, 334, 333]);
    expect(previewShares(10, 4)).toEqual([3, 3, 2, 2]);
  });

  it("never loses or invents a penny", () => {
    for (let people = 2; people <= 20; people += 1) {
      for (const total of [people, 99, 100, 101, 1_234, 99_999]) {
        if (total < people) continue;
        const shares = previewShares(total, people);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it("shows nothing rather than something wrong", () => {
    expect(previewShares(10.5, 2)).toEqual([]);
    expect(previewShares(0, 2)).toEqual([]);
    expect(previewShares(100, 1)).toEqual([]);
    expect(previewShares(2, 3)).toEqual([]);
  });
});

describe("previewSplit", () => {
  it("gives the organiser the odd pennies", () => {
    expect(previewSplit(1_000, 2)).toEqual({ yours: 334, theirs: [333, 333] });
  });

  it("can leave the organiser out", () => {
    expect(previewSplit(1_000, 2, false)).toEqual({ yours: 0, theirs: [500, 500] });
  });

  it("is null until there's something to show", () => {
    expect(previewSplit(1_000, 0)).toBeNull();
    expect(previewSplit(0, 2)).toBeNull();
  });
});
