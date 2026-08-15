import { describe, expect, it } from "vitest";
import {
  buildCandidateContext,
  hasSevereMisconception,
  repeatedFailureScore,
  scoreActiveRecall,
  scoreChallenge,
  scorePrerequisiteReview,
  scoreRemediation,
  scoreReview,
  successStreak,
} from "@/lib/learning/adaptive/action-scoring";
import { calculateConceptValue } from "@/lib/learning/adaptive/concept-scoring";
import { attempt, buildState, concept, mastery, mistake } from "./fixtures";

describe("repeatedFailureScore", () => {
  it("3 failures in the last 5 attempts strongly favors remediation", () => {
    const attempts = [
      attempt({ conceptId: "c1", score: 0.1 }), // most recent
      attempt({ conceptId: "c1", score: 0.9 }),
      attempt({ conceptId: "c1", score: 0.1 }),
      attempt({ conceptId: "c1", score: 0.1 }),
      attempt({ conceptId: "c1", score: 0.9 }),
    ];
    expect(repeatedFailureScore(attempts)).toBeGreaterThan(0.5);
  });

  it("mostly-successful recent attempts score low", () => {
    const attempts = Array.from({ length: 5 }, () => attempt({ conceptId: "c1", score: 0.9 }));
    expect(repeatedFailureScore(attempts)).toBeLessThan(0.2);
  });

  it("decays as performance improves — a recent success run outweighs older failures", () => {
    const improving = [
      attempt({ conceptId: "c1", score: 0.9 }),
      attempt({ conceptId: "c1", score: 0.9 }),
      attempt({ conceptId: "c1", score: 0.1 }),
      attempt({ conceptId: "c1", score: 0.1 }),
      attempt({ conceptId: "c1", score: 0.1 }),
    ];
    const declining = [
      attempt({ conceptId: "c1", score: 0.1 }),
      attempt({ conceptId: "c1", score: 0.1 }),
      attempt({ conceptId: "c1", score: 0.9 }),
      attempt({ conceptId: "c1", score: 0.9 }),
      attempt({ conceptId: "c1", score: 0.9 }),
    ];
    expect(repeatedFailureScore(improving)).toBeLessThan(repeatedFailureScore(declining));
  });

  it("empty history scores 0", () => {
    expect(repeatedFailureScore([])).toBe(0);
  });

  it("stays within [0,1]", () => {
    const allFailures = Array.from({ length: 10 }, () => attempt({ conceptId: "c1", score: 0 }));
    expect(repeatedFailureScore(allFailures)).toBeLessThanOrEqual(1);
  });
});

describe("successStreak", () => {
  it("counts leading successes only", () => {
    const attempts = [
      attempt({ conceptId: "c1", score: 0.9 }),
      attempt({ conceptId: "c1", score: 0.9 }),
      attempt({ conceptId: "c1", score: 0.9 }),
      attempt({ conceptId: "c1", score: 0.1 }),
    ];
    expect(successStreak(attempts)).toBe(3);
  });

  it("a leading failure means zero streak, even with successes after it", () => {
    const attempts = [attempt({ conceptId: "c1", score: 0.1 }), attempt({ conceptId: "c1", score: 0.9 })];
    expect(successStreak(attempts)).toBe(0);
  });
});

describe("hasSevereMisconception", () => {
  it("detects a recent high-severity misconception", () => {
    expect(
      hasSevereMisconception([mistake({ conceptId: "c1", category: "MISCONCEPTION", severity: "HIGH" })]),
    ).toBe(true);
  });

  it("ignores a low-severity misconception", () => {
    expect(
      hasSevereMisconception([mistake({ conceptId: "c1", category: "MISCONCEPTION", severity: "LOW" })]),
    ).toBe(false);
  });

  it("ignores a severe non-misconception mistake", () => {
    expect(
      hasSevereMisconception([mistake({ conceptId: "c1", category: "FACTUAL_ERROR", severity: "CRITICAL" })]),
    ).toBe(false);
  });

  it("ignores a stale misconception outside the relevance window", () => {
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    expect(
      hasSevereMisconception([mistake({ conceptId: "c1", category: "MISCONCEPTION", severity: "CRITICAL", createdAt: longAgo })]),
    ).toBe(false);
  });
});

describe("action scoring — high mastery + performance", () => {
  it("high mastery + strong recent performance favors CHALLENGE over REMEDIATION", () => {
    const state = buildState({
      concepts: [concept("c1", "C1")],
      masteryByConceptId: new Map([["c1", mastery({ conceptId: "c1", overallMastery: 0.85, exposureCount: 6 })]]),
      recentAttemptsByConceptId: new Map([
        ["c1", Array.from({ length: 4 }, () => attempt({ conceptId: "c1", score: 0.95 }))],
      ]),
    });
    const value = calculateConceptValue("c1", state);
    const ctx = buildCandidateContext("c1", value, state);

    expect(scoreChallenge(ctx)).toBeGreaterThan(scoreRemediation(ctx));
  });

  it("high mastery + a recent severe misconception favors REMEDIATION over CHALLENGE (spec §21-22)", () => {
    const state = buildState({
      concepts: [concept("c1", "C1")],
      masteryByConceptId: new Map([["c1", mastery({ conceptId: "c1", overallMastery: 0.85, exposureCount: 6 })]]),
      recentAttemptsByConceptId: new Map([
        ["c1", Array.from({ length: 4 }, () => attempt({ conceptId: "c1", score: 0.95 }))],
      ]),
      recentMistakesByConceptId: new Map([
        ["c1", [mistake({ conceptId: "c1", category: "MISCONCEPTION", severity: "HIGH" })]],
      ]),
    });
    const value = calculateConceptValue("c1", state);
    const ctx = buildCandidateContext("c1", value, state);

    expect(scoreRemediation(ctx)).toBeGreaterThan(scoreChallenge(ctx));
    expect(scoreChallenge(ctx)).toBe(0);
  });
});

describe("action scoring — prerequisite blocking", () => {
  it("a blocked concept scores PREREQUISITE_REVIEW above plain ACTIVE_RECALL", () => {
    const state = buildState({
      concepts: [concept("firewalls", "Firewalls"), concept("ports", "Ports")],
      masteryByConceptId: new Map([
        ["firewalls", mastery({ conceptId: "firewalls", overallMastery: 0.3 })],
        ["ports", mastery({ conceptId: "ports", overallMastery: 0.15 })],
      ]),
      prerequisitesByTarget: new Map([["firewalls", ["ports"]]]),
    });
    const value = calculateConceptValue("firewalls", state);
    const ctx = buildCandidateContext("firewalls", value, state);

    expect(scorePrerequisiteReview(ctx)).toBeGreaterThan(0);
    expect(scorePrerequisiteReview(ctx)).toBeGreaterThan(scoreActiveRecall(ctx));
  });

  it("an unblocked concept never generates a PREREQUISITE_REVIEW candidate", () => {
    const state = buildState({
      concepts: [concept("c1", "C1")],
      masteryByConceptId: new Map([["c1", mastery({ conceptId: "c1", overallMastery: 0.5 })]]),
    });
    const value = calculateConceptValue("c1", state);
    const ctx = buildCandidateContext("c1", value, state);
    expect(scorePrerequisiteReview(ctx)).toBe(0);
  });
});

describe("action scoring — review vs active recall", () => {
  it("reasonable mastery with rising forgetting risk favors REVIEW", () => {
    const longAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const state = buildState({
      concepts: [concept("c1", "C1")],
      masteryByConceptId: new Map([
        ["c1", mastery({ conceptId: "c1", overallMastery: 0.65, exposureCount: 5, lastAttemptAt: longAgo })],
      ]),
    });
    const value = calculateConceptValue("c1", state);
    const ctx = buildCandidateContext("c1", value, state);
    expect(scoreReview(ctx)).toBeGreaterThan(0);
  });

  it("still-weak concepts never score REVIEW — that's Active Recall's job", () => {
    const state = buildState({
      concepts: [concept("c1", "C1")],
      masteryByConceptId: new Map([["c1", mastery({ conceptId: "c1", overallMastery: 0.2 })]]),
    });
    const value = calculateConceptValue("c1", state);
    const ctx = buildCandidateContext("c1", value, state);
    expect(scoreReview(ctx)).toBe(0);
  });
});

describe("action scores stay within bounds", () => {
  it("every scorer returns a value in [0,1] for an extreme input", () => {
    const state = buildState({
      concepts: [concept("c1", "C1")],
      masteryByConceptId: new Map([["c1", mastery({ conceptId: "c1", overallMastery: 0, exposureCount: 5 })]]),
      recentAttemptsByConceptId: new Map([
        ["c1", Array.from({ length: 5 }, () => attempt({ conceptId: "c1", score: 0 }))],
      ]),
      recentMistakesByConceptId: new Map([
        ["c1", Array.from({ length: 10 }, () => mistake({ conceptId: "c1", severity: "CRITICAL" }))],
      ]),
    });
    const value = calculateConceptValue("c1", state);
    const ctx = buildCandidateContext("c1", value, state);

    for (const score of [scoreActiveRecall(ctx), scoreRemediation(ctx), scorePrerequisiteReview(ctx), scoreReview(ctx), scoreChallenge(ctx)]) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});
