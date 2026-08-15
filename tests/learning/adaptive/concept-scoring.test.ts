import { describe, expect, it } from "vitest";
import {
  calculateConceptValue,
  calculateForgettingRiskScore,
  calculateGoalRelevanceScore,
  calculatePrerequisiteImportance,
  calculateRecencyPenalty,
  calculateRecentMistakeScore,
  calculateWeaknessScore,
  findPrerequisiteBlock,
} from "@/lib/learning/adaptive/concept-scoring";
import { RECENCY_WINDOW_SIZE } from "@/lib/learning/adaptive/config";
import { attempt, buildState, concept, goal, mastery, mistake } from "./fixtures";

describe("calculateWeaknessScore", () => {
  it("mastery 0.2 -> high weakness", () => {
    expect(calculateWeaknessScore(mastery({ overallMastery: 0.2 }))).toBeCloseTo(0.8);
  });

  it("mastery 0.9 -> low weakness", () => {
    expect(calculateWeaknessScore(mastery({ overallMastery: 0.9 }))).toBeCloseTo(0.1);
  });

  it("no mastery record (never attempted) -> maximal weakness, not an error", () => {
    expect(calculateWeaknessScore(undefined)).toBe(1);
  });

  it("stays within [0,1]", () => {
    expect(calculateWeaknessScore(mastery({ overallMastery: 0 }))).toBeLessThanOrEqual(1);
    expect(calculateWeaknessScore(mastery({ overallMastery: 1 }))).toBeGreaterThanOrEqual(0);
  });
});

describe("findPrerequisiteBlock", () => {
  it("a weak target with a weak prerequisite is blocked (Firewalls/Ports example, spec §9)", () => {
    const state = buildState({
      concepts: [concept("firewalls", "Firewalls"), concept("ports", "Ports")],
      masteryByConceptId: new Map([
        ["firewalls", mastery({ conceptId: "firewalls", conceptName: "Firewalls", overallMastery: 0.3 })],
        ["ports", mastery({ conceptId: "ports", conceptName: "Ports", overallMastery: 0.15 })],
      ]),
      prerequisitesByTarget: new Map([["firewalls", ["ports"]]]),
    });

    const block = findPrerequisiteBlock("firewalls", state);
    expect(block.blocked).toBe(true);
    expect(block.blockingConceptId).toBe("ports");
  });

  it("a strong target is never blocked, even by a weak prerequisite (spec §10)", () => {
    const state = buildState({
      concepts: [concept("target", "Target"), concept("prereq", "Prereq")],
      masteryByConceptId: new Map([
        ["target", mastery({ conceptId: "target", overallMastery: 0.75 })],
        ["prereq", mastery({ conceptId: "prereq", overallMastery: 0.35 })],
      ]),
      prerequisitesByTarget: new Map([["target", ["prereq"]]]),
    });

    expect(findPrerequisiteBlock("target", state).blocked).toBe(false);
  });

  it("a weak target is not blocked by a strong prerequisite — practice it directly (spec §10)", () => {
    const state = buildState({
      concepts: [concept("target", "Target"), concept("prereq", "Prereq")],
      masteryByConceptId: new Map([
        ["target", mastery({ conceptId: "target", overallMastery: 0.35 })],
        ["prereq", mastery({ conceptId: "prereq", overallMastery: 0.65 })],
      ]),
      prerequisitesByTarget: new Map([["target", ["prereq"]]]),
    });

    expect(findPrerequisiteBlock("target", state).blocked).toBe(false);
  });

  it("recursively finds the weakest ancestor across multiple hops (TCP/IP -> TCP -> Ports -> Firewalls, spec §8)", () => {
    const state = buildState({
      concepts: [concept("tcpip", "TCP/IP"), concept("tcp", "TCP"), concept("ports", "Ports"), concept("firewalls", "Firewalls")],
      masteryByConceptId: new Map([
        ["tcpip", mastery({ conceptId: "tcpip", overallMastery: 0.95 })],
        ["tcp", mastery({ conceptId: "tcp", overallMastery: 0.8 })],
        ["ports", mastery({ conceptId: "ports", overallMastery: 0.3 })],
        ["firewalls", mastery({ conceptId: "firewalls", overallMastery: 0.35 })],
      ]),
      prerequisitesByTarget: new Map([
        ["firewalls", ["ports"]],
        ["ports", ["tcp"]],
        ["tcp", ["tcpip"]],
      ]),
    });

    const block = findPrerequisiteBlock("firewalls", state);
    expect(block.blocked).toBe(true);
    expect(block.blockingConceptId).toBe("ports"); // the weakest eligible ancestor, not TCP/TCP/IP which are already strong
  });

  it("respects the max traversal depth instead of infinite-looping on a cycle", () => {
    const state = buildState({
      concepts: [concept("a", "A"), concept("b", "B"), concept("c", "C")],
      masteryByConceptId: new Map([
        ["a", mastery({ conceptId: "a", overallMastery: 0.1 })],
        ["b", mastery({ conceptId: "b", overallMastery: 0.1 })],
        ["c", mastery({ conceptId: "c", overallMastery: 0.1 })],
      ]),
      // a cycle: a depends on b, b depends on c, c depends on a
      prerequisitesByTarget: new Map([
        ["a", ["b"]],
        ["b", ["c"]],
        ["c", ["a"]],
      ]),
    });

    expect(() => findPrerequisiteBlock("a", state, 5)).not.toThrow();
  });
});

describe("calculatePrerequisiteImportance", () => {
  it("a concept blocking a very weak downstream concept gets high importance", () => {
    const state = buildState({
      concepts: [concept("ports", "Ports"), concept("firewalls", "Firewalls")],
      masteryByConceptId: new Map([["firewalls", mastery({ conceptId: "firewalls", overallMastery: 0.1 })]]),
      prerequisitesByTarget: new Map([["firewalls", ["ports"]]]),
    });

    expect(calculatePrerequisiteImportance("ports", state)).toBeGreaterThan(0.8);
  });

  it("a concept with no dependents has zero importance", () => {
    const state = buildState({ concepts: [concept("isolated", "Isolated")] });
    expect(calculatePrerequisiteImportance("isolated", state)).toBe(0);
  });
});

describe("calculateRecentMistakeScore", () => {
  it("a recent severe mistake scores high", () => {
    const state = buildState({
      recentMistakesByConceptId: new Map([
        ["c1", [mistake({ conceptId: "c1", severity: "CRITICAL", createdAt: new Date() })]],
      ]),
    });
    expect(calculateRecentMistakeScore("c1", state)).toBeGreaterThan(0.5);
  });

  it("an old, minor mistake scores low", () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const state = buildState({
      recentMistakesByConceptId: new Map([["c1", [mistake({ conceptId: "c1", severity: "LOW", createdAt: twentyDaysAgo })]]]),
    });
    expect(calculateRecentMistakeScore("c1", state)).toBeLessThan(0.2);
  });

  it("a mistake outside the relevance window contributes nothing", () => {
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const state = buildState({
      recentMistakesByConceptId: new Map([["c1", [mistake({ conceptId: "c1", severity: "CRITICAL", createdAt: longAgo })]]]),
    });
    expect(calculateRecentMistakeScore("c1", state)).toBe(0);
  });

  it("stays within [0,1] even with many severe mistakes", () => {
    const many = Array.from({ length: 20 }, () => mistake({ conceptId: "c1", severity: "CRITICAL", createdAt: new Date() }));
    const state = buildState({ recentMistakesByConceptId: new Map([["c1", many]]) });
    expect(calculateRecentMistakeScore("c1", state)).toBeLessThanOrEqual(1);
  });
});

describe("calculateForgettingRiskScore", () => {
  it("recently practiced + high mastery -> low risk", () => {
    const state = buildState({
      masteryByConceptId: new Map([
        ["c1", mastery({ conceptId: "c1", overallMastery: 0.9, exposureCount: 5, lastAttemptAt: new Date() })],
      ]),
    });
    expect(calculateForgettingRiskScore("c1", state)).toBeLessThan(0.1);
  });

  it("long absence -> higher risk than recent practice, at the same mastery", () => {
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const state = buildState({
      masteryByConceptId: new Map([
        ["c1", mastery({ conceptId: "c1", overallMastery: 0.6, exposureCount: 5, lastAttemptAt: longAgo })],
      ]),
    });
    const recentState = buildState({
      masteryByConceptId: new Map([
        ["c1", mastery({ conceptId: "c1", overallMastery: 0.6, exposureCount: 5, lastAttemptAt: new Date() })],
      ]),
    });
    expect(calculateForgettingRiskScore("c1", state)).toBeGreaterThan(calculateForgettingRiskScore("c1", recentState));
  });

  it("never learned -> weakness, not forgetting (spec §13)", () => {
    const state = buildState({
      masteryByConceptId: new Map([["c1", mastery({ conceptId: "c1", overallMastery: 0, exposureCount: 0 })]]),
    });
    expect(calculateForgettingRiskScore("c1", state)).toBe(0);
  });
});

describe("calculateRecencyPenalty", () => {
  it("a just-practiced concept receives a penalty", () => {
    const state = buildState({ recentlyPracticedConceptIds: ["c1", "c2", "c3"] });
    expect(calculateRecencyPenalty("c1", state)).toBeGreaterThan(0);
  });

  it("a concept not practiced recently receives no penalty", () => {
    const state = buildState({ recentlyPracticedConceptIds: ["c2", "c3"] });
    expect(calculateRecencyPenalty("c1", state)).toBe(0);
  });

  it("penalty decays further back in the recency window", () => {
    const ids = Array.from({ length: RECENCY_WINDOW_SIZE }, (_, i) => `c${i}`);
    const state = buildState({ recentlyPracticedConceptIds: ids });
    expect(calculateRecencyPenalty(ids[0], state)).toBeGreaterThan(calculateRecencyPenalty(ids[ids.length - 1], state));
  });
});

describe("calculateGoalRelevanceScore", () => {
  it("no goals -> zero relevance", () => {
    expect(calculateGoalRelevanceScore("c1", buildState())).toBe(0);
  });

  it("an exam soon increases relevance for a targeted concept", () => {
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const state = buildState({ goals: [goal({ type: "EXAM", targetDate: soon, targetConceptIds: ["c1"] })] });
    expect(calculateGoalRelevanceScore("c1", state)).toBeGreaterThan(0.5);
  });

  it("an exam far away increases relevance less than one that's imminent", () => {
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const far = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    const soonState = buildState({ goals: [goal({ type: "EXAM", targetDate: soon })] });
    const farState = buildState({ goals: [goal({ type: "EXAM", targetDate: far })] });
    expect(calculateGoalRelevanceScore("c1", soonState)).toBeGreaterThan(calculateGoalRelevanceScore("c1", farState));
  });

  it("a goal scoped to other concepts doesn't apply here", () => {
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const state = buildState({ goals: [goal({ type: "EXAM", targetDate: soon, targetConceptIds: ["other"] })] });
    expect(calculateGoalRelevanceScore("c1", state)).toBe(0);
  });
});

describe("calculateConceptValue", () => {
  it("combines components and stays within [0,1]", () => {
    const state = buildState({
      concepts: [concept("c1", "C1")],
      masteryByConceptId: new Map([["c1", mastery({ conceptId: "c1", overallMastery: 0.1, exposureCount: 3, lastAttemptAt: new Date() })]]),
      recentAttemptsByConceptId: new Map([["c1", [attempt({ conceptId: "c1", score: 0.1 })]]]),
      recentMistakesByConceptId: new Map([["c1", [mistake({ conceptId: "c1", severity: "CRITICAL" })]]]),
      goals: [goal({ type: "EXAM", targetDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) })],
      recentlyPracticedConceptIds: ["c1"],
    });

    const value = calculateConceptValue("c1", state);
    expect(value.value).toBeGreaterThanOrEqual(0);
    expect(value.value).toBeLessThanOrEqual(1);
  });
});
