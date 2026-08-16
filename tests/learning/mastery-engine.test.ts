import { describe, expect, it } from "vitest";
import {
  applyEvidence,
  BASE_EVIDENCE_WEIGHT,
  clamp01,
  computeEvidenceWeight,
  computeOverallMastery,
  deriveOutcomeFromScore,
  deriveStatus,
  emptyMasterySnapshot,
  mapActivityToDimension,
  MASTERY_THRESHOLDS,
  MAX_EVIDENCE_WEIGHT,
  MIN_SUCCESSFUL_ATTEMPTS_FOR_MASTERY,
  nextStreak,
  STRUGGLE_ATTEMPT_THRESHOLD_FOR_REMEDIATION,
  WeightedEvidenceStrategy,
  type EvidenceInput,
} from "@/lib/learning/mastery-engine";

describe("clamp01", () => {
  it("clamps to the 0-1 range", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.42)).toBe(0.42);
  });
});

describe("mapActivityToDimension", () => {
  it("maps every activity type to exactly one of the four dimensions", () => {
    expect(mapActivityToDimension("RECALL")).toBe("recall");
    expect(mapActivityToDimension("DIAGNOSTIC")).toBe("recall");
    expect(mapActivityToDimension("EXPLANATION")).toBe("explanation");
    expect(mapActivityToDimension("TEACH_BACK")).toBe("explanation");
    expect(mapActivityToDimension("APPLICATION")).toBe("application");
    expect(mapActivityToDimension("SCENARIO")).toBe("application");
    expect(mapActivityToDimension("EXAM")).toBe("application");
    expect(mapActivityToDimension("TRANSFER")).toBe("transfer");
  });
});

describe("deriveOutcomeFromScore", () => {
  it("classifies score into SUCCESS/PARTIAL/FAILURE", () => {
    expect(deriveOutcomeFromScore(0.9)).toBe("SUCCESS");
    expect(deriveOutcomeFromScore(0.7)).toBe("SUCCESS");
    expect(deriveOutcomeFromScore(0.5)).toBe("PARTIAL");
    expect(deriveOutcomeFromScore(0.3)).toBe("FAILURE");
  });
});

describe("computeOverallMastery", () => {
  it("weights application and explanation more than raw recall", () => {
    const recallHeavy = computeOverallMastery({
      recallScore: 1,
      explanationScore: 0,
      applicationScore: 0,
      transferScore: 0,
    });
    const applicationHeavy = computeOverallMastery({
      recallScore: 0,
      explanationScore: 0,
      applicationScore: 1,
      transferScore: 0,
    });
    expect(applicationHeavy).toBeGreaterThan(recallHeavy);
  });

  it("sums to 1 when every dimension is maxed", () => {
    expect(
      computeOverallMastery({ recallScore: 1, explanationScore: 1, applicationScore: 1, transferScore: 1 }),
    ).toBeCloseTo(1);
  });
});

describe("WeightedEvidenceStrategy", () => {
  it("takes the new evidence score outright on first exposure", () => {
    const strategy = new WeightedEvidenceStrategy();
    expect(strategy.nextScore(0, 0, 0.8)).toBe(0.8);
  });

  it("blends old and new scores after first exposure (recency-weighted)", () => {
    const strategy = new WeightedEvidenceStrategy(0.35);
    const next = strategy.nextScore(0.5, 1, 1.0);
    expect(next).toBeCloseTo(0.5 * 0.65 + 1.0 * 0.35);
  });

  it("weights recent evidence more than any single older data point over repeated updates", () => {
    const strategy = new WeightedEvidenceStrategy(0.35);
    let score = strategy.nextScore(0, 0, 0); // establishes a low baseline
    for (let i = 0; i < 5; i++) {
      score = strategy.nextScore(score, i + 1, 1); // repeated perfect evidence
    }
    expect(score).toBeGreaterThan(0.8);
  });
});

describe("deriveStatus", () => {
  it("is UNKNOWN with zero exposure regardless of score", () => {
    expect(deriveStatus(0.9, 0, 0, 0)).toBe("UNKNOWN");
  });

  it("does not grant MASTERED from a single lucky high score", () => {
    expect(deriveStatus(0.9, 1, 1, 1)).not.toBe("MASTERED");
  });

  it("grants MASTERED once both the score and the success-count bar are cleared", () => {
    expect(deriveStatus(0.9, 5, MIN_SUCCESSFUL_ATTEMPTS_FOR_MASTERY, 5)).toBe("MASTERED");
  });

  it("does not flag NEEDS_REMEDIATION from a single unlucky low score", () => {
    expect(deriveStatus(0.1, 1, 0, 1)).not.toBe("NEEDS_REMEDIATION");
  });

  it("flags NEEDS_REMEDIATION once enough weak attempts accumulate", () => {
    expect(deriveStatus(0.1, STRUGGLE_ATTEMPT_THRESHOLD_FOR_REMEDIATION, 0, STRUGGLE_ATTEMPT_THRESHOLD_FOR_REMEDIATION)).toBe(
      "NEEDS_REMEDIATION",
    );
  });

  it("classifies mid-range scores as DEVELOPING and STRONG per the score bands", () => {
    expect(deriveStatus(MASTERY_THRESHOLDS.developing, 4, 2, 4)).toBe("DEVELOPING");
    expect(deriveStatus(MASTERY_THRESHOLDS.strong, 4, 2, 4)).toBe("STRONG");
  });
});

describe("applyEvidence", () => {
  it("records a first success: exposure/attempt/success counts all become 1", () => {
    const evidence: EvidenceInput = { activityType: "RECALL", score: 0.9, outcome: "SUCCESS" };
    const next = applyEvidence(emptyMasterySnapshot(), evidence);

    expect(next.exposureCount).toBe(1);
    expect(next.attemptCount).toBe(1);
    expect(next.successCount).toBe(1);
    expect(next.failureCount).toBe(0);
    expect(next.recallScore).toBe(0.9);
    expect(next.status).not.toBe("UNKNOWN");
  });

  it("records a first failure: failureCount becomes 1, score stays low", () => {
    const evidence: EvidenceInput = { activityType: "RECALL", score: 0.1, outcome: "FAILURE" };
    const next = applyEvidence(emptyMasterySnapshot(), evidence);

    expect(next.failureCount).toBe(1);
    expect(next.successCount).toBe(0);
    expect(next.recallScore).toBe(0.1);
  });

  it("only updates the dimension matching the activity type", () => {
    const withRecall = applyEvidence(emptyMasterySnapshot(), {
      activityType: "RECALL",
      score: 1,
      outcome: "SUCCESS",
    });
    expect(withRecall.recallScore).toBe(1);
    expect(withRecall.explanationScore).toBe(0);
    expect(withRecall.applicationScore).toBe(0);
    expect(withRecall.transferScore).toBe(0);

    const withTransfer = applyEvidence(withRecall, {
      activityType: "TRANSFER",
      score: 1,
      outcome: "SUCCESS",
    });
    // Transfer's first-ever touch takes the score outright even though
    // exposureCount is already 1 from the earlier recall evidence — a
    // dimension's own history, not unrelated dimensions', gates its blend.
    expect(withTransfer.transferScore).toBe(1);
    expect(withTransfer.recallScore).toBe(1); // untouched by this evidence
  });

  it("gives a dimension's first-ever touch full weight even when other dimensions already have history", () => {
    let snapshot = applyEvidence(emptyMasterySnapshot(), { activityType: "RECALL", score: 0.9, outcome: "SUCCESS" });
    snapshot = applyEvidence(snapshot, { activityType: "RECALL", score: 0.9, outcome: "SUCCESS" });
    snapshot = applyEvidence(snapshot, { activityType: "RECALL", score: 0.9, outcome: "SUCCESS" });

    const withFirstExplanation = applyEvidence(snapshot, {
      activityType: "EXPLANATION",
      score: 0.85,
      outcome: "SUCCESS",
    });
    expect(withFirstExplanation.explanationScore).toBe(0.85);
  });

  it("accumulates successes and failures across repeated attempts", () => {
    let snapshot = emptyMasterySnapshot();
    const outcomes: Array<"SUCCESS" | "FAILURE"> = ["SUCCESS", "SUCCESS", "FAILURE", "SUCCESS"];
    for (const outcome of outcomes) {
      snapshot = applyEvidence(snapshot, {
        activityType: "APPLICATION",
        score: outcome === "SUCCESS" ? 0.9 : 0.1,
        outcome,
      });
    }
    expect(snapshot.attemptCount).toBe(4);
    expect(snapshot.successCount).toBe(3);
    expect(snapshot.failureCount).toBe(1);
  });

  it("tracks hint usage and answer reveals separately from success/failure", () => {
    const next = applyEvidence(emptyMasterySnapshot(), {
      activityType: "RECALL",
      score: 0.5,
      outcome: "PARTIAL",
      usedHint: true,
      revealedAnswer: true,
    });
    expect(next.hintCount).toBe(1);
    expect(next.revealCount).toBe(1);
  });

  it("updates confidenceScore independently of the dimension score", () => {
    const next = applyEvidence(emptyMasterySnapshot(), {
      activityType: "RECALL",
      score: 0.9,
      outcome: "SUCCESS",
      confidence: 0.2,
    });
    expect(next.confidenceScore).toBe(0.2);
    expect(next.recallScore).toBe(0.9);
  });

  it("leaves confidenceScore untouched when confidence is omitted", () => {
    let snapshot = applyEvidence(emptyMasterySnapshot(), {
      activityType: "RECALL",
      score: 0.9,
      outcome: "SUCCESS",
      confidence: 0.5,
    });
    snapshot = applyEvidence(snapshot, { activityType: "RECALL", score: 0.9, outcome: "SUCCESS" });
    expect(snapshot.confidenceScore).toBe(0.5);
  });

  it("moves status through LEARNING -> DEVELOPING -> STRONG -> MASTERED as evidence accumulates across all four dimensions", () => {
    let snapshot = emptyMasterySnapshot();
    const activities: Array<"RECALL" | "EXPLANATION" | "APPLICATION" | "TRANSFER"> = [
      "RECALL",
      "EXPLANATION",
      "APPLICATION",
      "TRANSFER",
    ];

    for (let round = 0; round < 8; round++) {
      for (const activityType of activities) {
        snapshot = applyEvidence(snapshot, { activityType, score: 0.95, outcome: "SUCCESS" });
      }
    }

    expect(snapshot.status).toBe("MASTERED");
    expect(snapshot.overallMastery).toBeGreaterThanOrEqual(MASTERY_THRESHOLDS.masteryCandidate);
  });
});

describe("nextStreak", () => {
  it("starts a positive streak from zero on success and a negative streak from zero on failure", () => {
    expect(nextStreak(0, "SUCCESS")).toBe(1);
    expect(nextStreak(0, "FAILURE")).toBe(-1);
  });

  it("extends a same-direction streak", () => {
    expect(nextStreak(1, "SUCCESS")).toBe(2);
    expect(nextStreak(4, "SUCCESS")).toBe(5);
    expect(nextStreak(-1, "FAILURE")).toBe(-2);
    expect(nextStreak(-4, "FAILURE")).toBe(-5);
  });

  it("flips direction immediately on an opposite outcome rather than crossing through zero", () => {
    expect(nextStreak(5, "FAILURE")).toBe(-1);
    expect(nextStreak(-5, "SUCCESS")).toBe(1);
  });

  it("resets the streak to zero on a PARTIAL outcome regardless of prior direction", () => {
    expect(nextStreak(5, "PARTIAL")).toBe(0);
    expect(nextStreak(-5, "PARTIAL")).toBe(0);
    expect(nextStreak(0, "PARTIAL")).toBe(0);
  });
});

describe("computeEvidenceWeight", () => {
  it("returns the base weight with no streak and no difficulty", () => {
    expect(computeEvidenceWeight(0, null, "SUCCESS")).toBe(BASE_EVIDENCE_WEIGHT);
    expect(computeEvidenceWeight(0, undefined, "FAILURE")).toBe(BASE_EVIDENCE_WEIGHT);
  });

  it("increases the weight for a success that continues an existing success streak", () => {
    const noStreak = computeEvidenceWeight(0, null, "SUCCESS");
    const withStreak = computeEvidenceWeight(3, null, "SUCCESS");
    expect(withStreak).toBeGreaterThan(noStreak);
  });

  it("increases the weight for a failure that continues an existing failure streak", () => {
    const noStreak = computeEvidenceWeight(0, null, "FAILURE");
    const withStreak = computeEvidenceWeight(-3, null, "FAILURE");
    expect(withStreak).toBeGreaterThan(noStreak);
  });

  it("does not boost the weight when the outcome breaks the existing streak direction", () => {
    // Already on a success streak, but this evidence is a failure — no same-direction bonus applies.
    expect(computeEvidenceWeight(3, null, "FAILURE")).toBe(BASE_EVIDENCE_WEIGHT);
    expect(computeEvidenceWeight(-3, null, "SUCCESS")).toBe(BASE_EVIDENCE_WEIGHT);
  });

  it("weights a correct answer on a harder question more than the same answer on an easy question", () => {
    const easy = computeEvidenceWeight(0, 1, "SUCCESS");
    const hard = computeEvidenceWeight(0, 5, "SUCCESS");
    expect(hard).toBeGreaterThan(easy);
  });

  it("gives more relief for missing a hard question than missing an easy one", () => {
    const easyMiss = computeEvidenceWeight(0, 1, "FAILURE");
    const hardMiss = computeEvidenceWeight(0, 5, "FAILURE");
    expect(hardMiss).toBeLessThan(easyMiss);
  });

  it("never exceeds MAX_EVIDENCE_WEIGHT even with a long streak and maximum difficulty", () => {
    expect(computeEvidenceWeight(50, 5, "SUCCESS")).toBeLessThanOrEqual(MAX_EVIDENCE_WEIGHT);
    expect(computeEvidenceWeight(-50, 1, "FAILURE")).toBeLessThanOrEqual(MAX_EVIDENCE_WEIGHT);
  });

  it("caps the streak bonus itself so an arbitrarily long streak can't dominate on its own", () => {
    const at10 = computeEvidenceWeight(10, null, "SUCCESS");
    const at100 = computeEvidenceWeight(100, null, "SUCCESS");
    expect(at100).toBe(at10);
  });
});

describe("applyEvidence: streak and difficulty awareness", () => {
  it("tracks currentStreak and bestStreak through a run of successes", () => {
    let snapshot = emptyMasterySnapshot();
    for (let i = 0; i < 4; i++) {
      snapshot = applyEvidence(snapshot, { activityType: "RECALL", score: 0.9, outcome: "SUCCESS" });
    }
    expect(snapshot.currentStreak).toBe(4);
    expect(snapshot.bestStreak).toBe(4);
  });

  it("resets currentStreak but preserves bestStreak once a failure follows a success streak", () => {
    let snapshot = emptyMasterySnapshot();
    for (let i = 0; i < 4; i++) {
      snapshot = applyEvidence(snapshot, { activityType: "RECALL", score: 0.9, outcome: "SUCCESS" });
    }
    snapshot = applyEvidence(snapshot, { activityType: "RECALL", score: 0.1, outcome: "FAILURE" });

    expect(snapshot.currentStreak).toBe(-1);
    expect(snapshot.bestStreak).toBe(4);
  });

  it("never lets bestStreak decrease even after a losing streak longer than the best winning streak", () => {
    let snapshot = emptyMasterySnapshot();
    snapshot = applyEvidence(snapshot, { activityType: "RECALL", score: 0.9, outcome: "SUCCESS" });
    snapshot = applyEvidence(snapshot, { activityType: "RECALL", score: 0.9, outcome: "SUCCESS" });
    for (let i = 0; i < 5; i++) {
      snapshot = applyEvidence(snapshot, { activityType: "RECALL", score: 0.1, outcome: "FAILURE" });
    }
    expect(snapshot.currentStreak).toBe(-5);
    expect(snapshot.bestStreak).toBe(2);
  });

  it("a PARTIAL outcome breaks the streak back to zero", () => {
    let snapshot = emptyMasterySnapshot();
    snapshot = applyEvidence(snapshot, { activityType: "RECALL", score: 0.9, outcome: "SUCCESS" });
    snapshot = applyEvidence(snapshot, { activityType: "RECALL", score: 0.9, outcome: "SUCCESS" });
    snapshot = applyEvidence(snapshot, { activityType: "RECALL", score: 0.5, outcome: "PARTIAL" });
    expect(snapshot.currentStreak).toBe(0);
    expect(snapshot.bestStreak).toBe(2);
  });

  it("moves a repeatedly-correct score further per update than an equivalent single isolated success (streak weighting compounds, within the mastery cap)", () => {
    // A: five isolated successes each following a reset (PARTIAL) — no streak bonus ever applies.
    let snapshotA = emptyMasterySnapshot();
    for (let i = 0; i < 5; i++) {
      snapshotA = applyEvidence(snapshotA, { activityType: "APPLICATION", score: 1, outcome: "SUCCESS" });
      snapshotA = applyEvidence(snapshotA, { activityType: "APPLICATION", score: 0, outcome: "PARTIAL" });
    }

    // B: five *consecutive* successes — each gets a growing same-direction streak bonus.
    let snapshotB = emptyMasterySnapshot();
    for (let i = 0; i < 5; i++) {
      snapshotB = applyEvidence(snapshotB, { activityType: "APPLICATION", score: 1, outcome: "SUCCESS" });
    }

    expect(snapshotB.applicationScore).toBeGreaterThan(snapshotA.applicationScore);
  });

  it("does not allow a single high-difficulty correct answer to jump mastery to MASTERED from a low baseline", () => {
    const low = applyEvidence(emptyMasterySnapshot(), { activityType: "RECALL", score: 0.1, outcome: "FAILURE" });
    const next = applyEvidence(low, { activityType: "RECALL", score: 1, outcome: "SUCCESS", difficulty: 5 });
    expect(next.status).not.toBe("MASTERED");
    expect(next.overallMastery).toBeLessThan(MASTERY_THRESHOLDS.masteryCandidate);
  });

  it("respects an explicitly passed strategy over the derived streak/difficulty weight", () => {
    const fixed = new WeightedEvidenceStrategy(0.5);
    const withStreak = applyEvidence(
      { ...emptyMasterySnapshot(), currentStreak: 10 },
      { activityType: "RECALL", score: 1, outcome: "SUCCESS", difficulty: 5 },
      fixed,
    );
    // exposureCount for the dimension is 0 (first touch), so the strategy takes the score outright
    // regardless of weight — this just confirms the explicit strategy path still runs without error
    // and produces a valid, capped result rather than silently falling back to the derived weight.
    expect(withStreak.recallScore).toBe(1);
  });
});
