import { describe, expect, it } from "vitest";
import { calculateReviewUrgencyScore, calculateConceptValue } from "@/lib/learning/adaptive/concept-scoring";
import { buildCandidateContext, scoreReview } from "@/lib/learning/adaptive/action-scoring";
import { REVIEW_URGENCY_SATURATION_DAYS } from "@/lib/learning/adaptive/config";
import { buildState, concept, mastery } from "../learning/adaptive/fixtures";

/**
 * Phase 9 -> Phase 6 integration (spec §8, §12): due reviews feed the
 * *existing* REVIEW action score rather than a second, competing priority
 * system. `state.reviewByConceptId` is optional specifically so every
 * existing Phase 6 test/fixture keeps working unmodified — these tests
 * cover the new behavior it unlocks.
 */

describe("calculateReviewUrgencyScore", () => {
  it("is 0 when the concept has no ReviewItem data at all", () => {
    const state = buildState({ concepts: [concept("c1", "C1")] });
    expect(calculateReviewUrgencyScore("c1", state)).toBe(0);
  });

  it("is 0 when a ReviewItem exists but isn't due yet", () => {
    const state = buildState({
      concepts: [concept("c1", "C1")],
      reviewByConceptId: new Map([["c1", { due: false, overdueDays: 0, status: "REVIEW" }]]),
    });
    expect(calculateReviewUrgencyScore("c1", state)).toBe(0);
  });

  it("saturates toward 1 as overdue days grow", () => {
    const state = buildState({
      concepts: [concept("c1", "C1")],
      reviewByConceptId: new Map([["c1", { due: true, overdueDays: REVIEW_URGENCY_SATURATION_DAYS * 3, status: "REVIEW" }]]),
    });
    expect(calculateReviewUrgencyScore("c1", state)).toBe(1);
  });

  it("scales roughly linearly below saturation", () => {
    const state = buildState({
      concepts: [concept("c1", "C1")],
      reviewByConceptId: new Map([["c1", { due: true, overdueDays: REVIEW_URGENCY_SATURATION_DAYS / 2, status: "REVIEW" }]]),
    });
    expect(calculateReviewUrgencyScore("c1", state)).toBeCloseTo(0.5, 1);
  });
});

describe("scoreReview consuming the review-due signal (spec §8, §12)", () => {
  it("a concept overdue for review scores REVIEW even with no forgetting-risk history", () => {
    const state = buildState({
      concepts: [concept("c1", "C1")],
      masteryByConceptId: new Map([["c1", mastery({ conceptId: "c1", overallMastery: 0.6, exposureCount: 3 })]]),
      reviewByConceptId: new Map([["c1", { due: true, overdueDays: 5, status: "REVIEW" }]]),
    });
    const value = calculateConceptValue("c1", state);
    const ctx = buildCandidateContext("c1", value, state);
    expect(scoreReview(ctx)).toBeGreaterThan(0);
  });

  it("still-weak concepts never score REVIEW even when overdue — that stays Active Recall's job", () => {
    const state = buildState({
      concepts: [concept("c1", "C1")],
      masteryByConceptId: new Map([["c1", mastery({ conceptId: "c1", overallMastery: 0.1 })]]),
      reviewByConceptId: new Map([["c1", { due: true, overdueDays: 30, status: "RELEARNING" }]]),
    });
    const value = calculateConceptValue("c1", state);
    const ctx = buildCandidateContext("c1", value, state);
    expect(scoreReview(ctx)).toBe(0);
  });

  it("existing (no review data) behavior is unchanged — scoreReview matches its Phase 6 forgettingRisk-only value", () => {
    const longAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const state = buildState({
      concepts: [concept("c1", "C1")],
      masteryByConceptId: new Map([["c1", mastery({ conceptId: "c1", overallMastery: 0.65, exposureCount: 5, lastAttemptAt: longAgo })]]),
    });
    const value = calculateConceptValue("c1", state);
    const ctx = buildCandidateContext("c1", value, state);
    expect(scoreReview(ctx)).toBeCloseTo(value.forgettingRisk, 10);
  });
});
