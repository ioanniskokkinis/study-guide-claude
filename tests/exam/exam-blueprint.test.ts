import { describe, expect, it } from "vitest";
import { allocateIntegers, buildExamBlueprint } from "@/lib/exam/exam-blueprint";
import { mastery } from "../learning/adaptive/fixtures";
import type { ExamConfig } from "@/lib/exam/types";

function baseConfig(overrides: Partial<ExamConfig> = {}): ExamConfig {
  return {
    courseId: "course-1",
    userId: "user-1",
    mode: "WRITTEN",
    questionCount: 20,
    durationMinutes: 45,
    difficulty: 2,
    allowHints: false,
    allowSources: false,
    passingScore: 0.75,
    ...overrides,
  };
}

describe("allocateIntegers (largest-remainder rounding)", () => {
  it("always sums exactly to the total", () => {
    const result = allocateIntegers([0.5, 0.3, 0.2], 20);
    expect(result.reduce((a, b) => a + b, 0)).toBe(20);
  });

  it("handles a single share", () => {
    expect(allocateIntegers([1], 7)).toEqual([7]);
  });

  it("handles an empty share list", () => {
    expect(allocateIntegers([], 10)).toEqual([]);
  });
});

describe("buildExamBlueprint (spec §5-6, §10-11)", () => {
  it("weak concepts receive appropriately larger diagnostic coverage than strong ones", () => {
    const concepts = [
      mastery({ conceptId: "tcp", conceptName: "TCP", overallMastery: 0.9 }),
      mastery({ conceptId: "ports", conceptName: "Ports", overallMastery: 0.3 }),
      mastery({ conceptId: "firewalls", conceptName: "Firewalls", overallMastery: 0.2 }),
    ];
    const blueprint = buildExamBlueprint({ config: baseConfig({ questionCount: 20 }), concepts });

    const tcp = blueprint.entries.find((e) => e.conceptId === "tcp")!;
    const ports = blueprint.entries.find((e) => e.conceptId === "ports")!;
    const firewalls = blueprint.entries.find((e) => e.conceptId === "firewalls")!;

    expect(tcp).toBeDefined();
    expect(ports.questionCount).toBeGreaterThan(tcp.questionCount);
    expect(firewalls.questionCount).toBeGreaterThan(tcp.questionCount);
    expect(tcp.tier).toBe("strong");
    expect(ports.tier).toBe("weak");
  });

  it("a strong concept is never dropped entirely — broad coverage, not just weak topics (spec §10)", () => {
    const concepts = [
      mastery({ conceptId: "tcp", conceptName: "TCP", overallMastery: 0.95 }),
      mastery({ conceptId: "ports", conceptName: "Ports", overallMastery: 0.1 }),
    ];
    const blueprint = buildExamBlueprint({ config: baseConfig({ questionCount: 10 }), concepts });
    const tcp = blueprint.entries.find((e) => e.conceptId === "tcp");
    expect(tcp).toBeDefined();
    expect(tcp!.questionCount).toBeGreaterThan(0);
  });

  it("never dedicates more than the configured max share to a single concept among many", () => {
    const concepts = Array.from({ length: 10 }, (_, i) => mastery({ conceptId: `c${i}`, conceptName: `C${i}`, overallMastery: 0.1 * i }));
    const blueprint = buildExamBlueprint({ config: baseConfig({ questionCount: 20 }), concepts });
    const maxCount = Math.max(...blueprint.entries.map((e) => e.questionCount));
    expect(maxCount).toBeLessThanOrEqual(Math.floor(20 * 0.4) + 1);
  });

  it("a single-concept retest legitimately gets the full question budget", () => {
    const concepts = [mastery({ conceptId: "ports", conceptName: "Ports", overallMastery: 0.2 })];
    const blueprint = buildExamBlueprint({
      config: baseConfig({ questionCount: 8, targetConceptIds: ["ports"], isRetest: true }),
      concepts,
    });
    expect(blueprint.entries).toHaveLength(1);
    expect(blueprint.entries[0].questionCount).toBe(8);
  });

  it("respects custom diagnostic ratio overrides", () => {
    const concepts = [
      mastery({ conceptId: "tcp", conceptName: "TCP", overallMastery: 0.9 }),
      mastery({ conceptId: "ports", conceptName: "Ports", overallMastery: 0.2 }),
    ];
    const blueprint = buildExamBlueprint({
      config: baseConfig({ questionCount: 10, coverage: { diagnosticRatios: { strong: 0.5, medium: 0, weak: 0.5 } } }),
      concepts,
    });
    const tcp = blueprint.entries.find((e) => e.conceptId === "tcp")!;
    const ports = blueprint.entries.find((e) => e.conceptId === "ports")!;
    expect(tcp.questionCount).toBe(ports.questionCount);
  });

  it("total allocated questions never exceeds the configured questionCount", () => {
    const concepts = Array.from({ length: 6 }, (_, i) => mastery({ conceptId: `c${i}`, conceptName: `C${i}`, overallMastery: 0.5 }));
    const blueprint = buildExamBlueprint({ config: baseConfig({ questionCount: 15 }), concepts });
    expect(blueprint.totalQuestions).toBeLessThanOrEqual(15);
  });

  it("returns an empty blueprint when there are no candidate concepts", () => {
    const blueprint = buildExamBlueprint({ config: baseConfig({ targetConceptIds: ["missing"] }), concepts: [] });
    expect(blueprint.entries).toHaveLength(0);
  });
});
