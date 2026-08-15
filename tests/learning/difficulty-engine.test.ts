import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import {
  clampDifficulty,
  computeNextDifficulty,
  getRecentPerformance,
  MAX_DIFFICULTY,
  MIN_DIFFICULTY,
  selectDifficultyForConcept,
} from "@/lib/learning/difficulty-engine";

describe("clampDifficulty", () => {
  it("clamps to [1,5]", () => {
    expect(clampDifficulty(0)).toBe(MIN_DIFFICULTY);
    expect(clampDifficulty(6)).toBe(MAX_DIFFICULTY);
    expect(clampDifficulty(3)).toBe(3);
  });
});

describe("computeNextDifficulty", () => {
  it("does not change difficulty from a single data point", () => {
    expect(computeNextDifficulty(3, [1.0])).toBe(3);
    expect(computeNextDifficulty(3, [0.0])).toBe(3);
  });

  it("increases difficulty on consecutive strong performance (>=85%)", () => {
    expect(computeNextDifficulty(2, [0.9, 0.95, 1.0])).toBe(3);
  });

  it("maintains difficulty on moderate performance (60-84%)", () => {
    expect(computeNextDifficulty(3, [0.7, 0.65, 0.75])).toBe(3);
  });

  it("decreases difficulty on weak performance (<60%)", () => {
    expect(computeNextDifficulty(3, [0.4, 0.3, 0.35])).toBe(2);
  });

  it("never exceeds the maximum difficulty", () => {
    expect(computeNextDifficulty(5, [0.9, 0.95, 1.0])).toBe(5);
  });

  it("never drops below the minimum difficulty", () => {
    expect(computeNextDifficulty(1, [0.1, 0.2, 0.0])).toBe(1);
  });
});

describe("difficulty-engine (DB-integration)", () => {
  let userId: string;
  let conceptId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-difficulty-${suffix}@example.com` } });
    userId = user.id;
    const course = await prisma.course.create({ data: { userId, title: "Difficulty course" } });
    const concept = await prisma.concept.create({
      data: { courseId: course.id, name: "Firewalls", normalizedName: "firewalls", difficulty: 2 },
    });
    conceptId = concept.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("falls back to the given difficulty with no attempt history", async () => {
    const recent = await getRecentPerformance(userId, conceptId);
    expect(recent).toHaveLength(0);

    const next = await selectDifficultyForConcept(userId, conceptId, 2);
    expect(next).toBe(2);
  });

  it("increases difficulty after consecutive real successes", async () => {
    for (const score of [0.9, 0.95, 0.92]) {
      await prisma.learningAttempt.create({
        data: { userId, conceptId, activityType: "RECALL", difficulty: 2, score, correctness: score },
      });
    }

    const next = await selectDifficultyForConcept(userId, conceptId, 2);
    expect(next).toBe(3);
  });
});
