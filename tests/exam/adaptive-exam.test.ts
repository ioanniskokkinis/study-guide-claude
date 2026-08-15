import { describe, expect, it } from "vitest";
import { nextAdaptiveDifficulty, nextAdaptiveStep, planAdaptiveSequence } from "@/lib/exam/adaptive-exam";
import { buildState, concept, mastery } from "../learning/adaptive/fixtures";
import type { ExamBlueprint } from "@/lib/exam/types";

describe("nextAdaptiveDifficulty (spec §12 — reacts every question, unlike Active Recall's smoothed difficulty)", () => {
  it("no prior answer holds at the current difficulty", () => {
    expect(nextAdaptiveDifficulty(3, null)).toBe(3);
  });

  it("a strong score (>=0.8) increases difficulty", () => {
    expect(nextAdaptiveDifficulty(3, 0.9)).toBe(4);
  });

  it("a weak score (<0.4) decreases difficulty", () => {
    expect(nextAdaptiveDifficulty(3, 0.2)).toBe(2);
  });

  it("a middling score holds steady", () => {
    expect(nextAdaptiveDifficulty(3, 0.6)).toBe(3);
  });

  it("never exceeds the [1,5] bound", () => {
    expect(nextAdaptiveDifficulty(5, 0.9)).toBe(5);
    expect(nextAdaptiveDifficulty(1, 0.1)).toBe(1);
  });
});

function buildBlueprint(): ExamBlueprint {
  return {
    entries: [
      { conceptId: "tcp", conceptName: "TCP", weight: 0.5, questionCount: 2, tier: "strong", cognitiveDistribution: { RECALL: 1, UNDERSTAND: 0, APPLY: 0, ANALYZE: 0, EVALUATE: 0 } },
      { conceptId: "ports", conceptName: "Ports", weight: 0.5, questionCount: 2, tier: "weak", cognitiveDistribution: { RECALL: 1, UNDERSTAND: 0, APPLY: 0, ANALYZE: 0, EVALUATE: 0 } },
    ],
    totalQuestions: 4,
    diagnosticRatios: { strong: 0.5, medium: 0, weak: 0.5 },
    cognitiveDistribution: { RECALL: 1, UNDERSTAND: 0, APPLY: 0, ANALYZE: 0, EVALUATE: 0 },
  };
}

describe("planAdaptiveSequence", () => {
  it("flattens the blueprint into the right total number of steps", () => {
    const plan = planAdaptiveSequence(buildBlueprint());
    expect(plan).toHaveLength(4);
  });
});

describe("nextAdaptiveStep (spec §12-13 — reuses the adaptive engine's own prerequisite blocking, never re-derives it)", () => {
  it("the first question follows the plan when there is no prior answer", () => {
    const state = buildState({ concepts: [concept("tcp", "TCP"), concept("ports", "Ports")] });
    const step = nextAdaptiveStep({ state, plannedSteps: planAdaptiveSequence(buildBlueprint()), consumedCount: 0, lastAnswer: null, currentDifficulty: 2 });
    expect(step?.reason).toBe("PLANNED");
    expect(step?.conceptId).toBe("tcp");
  });

  it("a correct answer continues down the plan", () => {
    const state = buildState({ concepts: [concept("tcp", "TCP"), concept("ports", "Ports")] });
    const step = nextAdaptiveStep({
      state,
      plannedSteps: planAdaptiveSequence(buildBlueprint()),
      consumedCount: 1,
      lastAnswer: { conceptId: "tcp", conceptName: "TCP", classification: "CORRECT", score: 0.9 },
      currentDifficulty: 3,
    });
    expect(step?.reason).toBe("PLANNED");
  });

  it("an incorrect answer on a prerequisite-blocked concept pivots to checking the prerequisite (spec's Q5 example)", () => {
    const state = buildState({
      concepts: [concept("tcp", "TCP"), concept("ports", "Ports"), concept("firewalls", "Firewalls")],
      masteryByConceptId: new Map([
        ["ports", mastery({ conceptId: "ports", overallMastery: 0.15 })],
        ["firewalls", mastery({ conceptId: "firewalls", overallMastery: 0.3 })],
      ]),
      prerequisitesByTarget: new Map([["firewalls", ["ports"]]]),
    });

    const step = nextAdaptiveStep({
      state,
      plannedSteps: planAdaptiveSequence(buildBlueprint()),
      consumedCount: 2,
      lastAnswer: { conceptId: "firewalls", conceptName: "Firewalls", classification: "INCORRECT", score: 0.1 },
      currentDifficulty: 4,
    });

    expect(step?.reason).toBe("PREREQUISITE_CHECK");
    expect(step?.conceptId).toBe("ports");
  });

  it("an incorrect answer with no prerequisite block asks an easier diagnostic follow-up on the same concept (spec's Q4 example)", () => {
    const state = buildState({
      concepts: [concept("tcp", "TCP")],
      masteryByConceptId: new Map([["tcp", mastery({ conceptId: "tcp", overallMastery: 0.6 })]]),
    });

    const step = nextAdaptiveStep({
      state,
      plannedSteps: planAdaptiveSequence(buildBlueprint()),
      consumedCount: 1,
      lastAnswer: { conceptId: "tcp", conceptName: "TCP", classification: "INCORRECT", score: 0.1 },
      currentDifficulty: 4,
    });

    expect(step?.reason).toBe("DIAGNOSTIC_FOLLOWUP");
    expect(step?.conceptId).toBe("tcp");
    expect(step?.difficulty).toBeLessThan(4);
  });

  it("returns null once the plan is exhausted and no detour is triggered", () => {
    const state = buildState({ concepts: [concept("tcp", "TCP"), concept("ports", "Ports")] });
    const step = nextAdaptiveStep({
      state,
      plannedSteps: planAdaptiveSequence(buildBlueprint()),
      consumedCount: 4,
      lastAnswer: { conceptId: "ports", conceptName: "Ports", classification: "CORRECT", score: 0.9 },
      currentDifficulty: 3,
    });
    expect(step).toBeNull();
  });
});
