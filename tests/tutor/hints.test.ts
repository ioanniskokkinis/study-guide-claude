import { describe, expect, it } from "vitest";
import { applyHintDiscount, hintLevelLabel, isReveal, nextHintLevel } from "@/lib/tutor/hints";

describe("hints (progressive escalation, spec §22-24)", () => {
  it("escalates one level at a time: 1st request -> HINT_1, 2nd -> HINT_2, 3rd -> HINT_3, 4th -> REVEAL", () => {
    let level = 0;
    level = nextHintLevel(level);
    expect(hintLevelLabel(level)).toBe("HINT_1");
    level = nextHintLevel(level);
    expect(hintLevelLabel(level)).toBe("HINT_2");
    level = nextHintLevel(level);
    expect(hintLevelLabel(level)).toBe("HINT_3");
    level = nextHintLevel(level);
    expect(hintLevelLabel(level)).toBe("REVEAL");
    expect(isReveal(level)).toBe(true);
  });

  it("never escalates past REVEAL", () => {
    expect(nextHintLevel(4)).toBe(4);
    expect(nextHintLevel(10)).toBe(4);
  });

  it("level 0 has no label", () => {
    expect(hintLevelLabel(0)).toBeNull();
    expect(isReveal(0)).toBe(false);
  });

  it("applies no discount without a hint", () => {
    expect(applyHintDiscount(0.9, 0)).toBe(0.9);
  });

  it("weakens evidence progressively for HINT_1 < no discount, HINT_2 weaker still, HINT_3 weakest", () => {
    const noHint = applyHintDiscount(0.9, 0);
    const hint1 = applyHintDiscount(0.9, 1);
    const hint2 = applyHintDiscount(0.9, 2);
    const hint3 = applyHintDiscount(0.9, 3);
    expect(hint1).toBeLessThan(noHint);
    expect(hint2).toBeLessThan(hint1);
    expect(hint3).toBeLessThan(hint2);
  });

  it("stays within [0,1]", () => {
    expect(applyHintDiscount(1, 3)).toBeGreaterThanOrEqual(0);
    expect(applyHintDiscount(1, 3)).toBeLessThanOrEqual(1);
    expect(applyHintDiscount(0, 1)).toBe(0);
  });
});
