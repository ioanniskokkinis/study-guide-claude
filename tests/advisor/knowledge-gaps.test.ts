import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { analyzeKnowledgeGaps, NoScopedConceptsError } from "@/lib/advisor/knowledge-gaps";
import { seedCourseWithConcepts } from "./fixtures";

/** Phase 15 §24-25, §32-34 — reuses Phase 6's scoring, filtered to scope. */
describe("analyzeKnowledgeGaps", () => {
  let userId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `gaps-${suffix}@example.com` } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("throws NoScopedConceptsError for an empty concept list", async () => {
    const { course } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    await expect(analyzeKnowledgeGaps(userId, course.id, [])).rejects.toBeInstanceOf(NoScopedConceptsError);
  });

  it("ranks a weak concept above a mastered one", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 2 });
    const [weak, strong] = concepts;
    await prisma.studentConceptMastery.createMany({
      data: [
        { userId, conceptId: weak.id, overallMastery: 0.1, exposureCount: 2, status: "LEARNING" },
        { userId, conceptId: strong.id, overallMastery: 0.95, exposureCount: 6, successCount: 6, status: "MASTERED" },
      ],
    });

    const summary = await analyzeKnowledgeGaps(userId, course.id, [weak.id, strong.id]);
    expect(summary.priorities[0].conceptId).toBe(weak.id);
    expect(summary.priorities[0].breakdown.value).toBeGreaterThan(summary.priorities[1].breakdown.value);
  });

  it("only includes concepts within the given scope, even if the course has more", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 3 });
    const scoped = concepts.slice(0, 2).map((c) => c.id);
    const summary = await analyzeKnowledgeGaps(userId, course.id, scoped);
    expect(summary.priorities.map((p) => p.conceptId).sort()).toEqual(scoped.sort());
  });

  it("buckets mastery correctly and computes overallMasteryPercent only from concepts with evidence", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 2 });
    const [attempted, untouched] = concepts;
    await prisma.studentConceptMastery.create({
      data: { userId, conceptId: attempted.id, overallMastery: 0.6, exposureCount: 4, status: "DEVELOPING" },
    });

    const summary = await analyzeKnowledgeGaps(userId, course.id, [attempted.id, untouched.id]);
    expect(summary.developingConceptCount).toBe(1);
    expect(summary.unknownConceptCount).toBe(1);
    expect(summary.overallMasteryPercent).toBeCloseTo(0.6, 5);
  });
});
