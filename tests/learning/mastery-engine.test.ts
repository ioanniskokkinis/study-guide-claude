import { describe, expect, it } from "vitest";
import {
  applyEvidence,
  clamp01,
  computeOverallMastery,
  deriveOutcomeFromScore,
  deriveStatus,
  emptyMasterySnapshot,
  mapActivityToDimension,
  MASTERY_THRESHOLDS,
  MIN_SUCCESSFUL_ATTEMPTS_FOR_MASTERY,
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
