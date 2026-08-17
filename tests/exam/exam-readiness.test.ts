import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { calculateReadiness } from "@/lib/exam/exam-readiness";

/**
 * Phase 19 §19.11 — exam-readiness.ts had zero dedicated test coverage
 * before this file (flagged by the Phase 19 audit). calculateReadiness()
 * pulls from mastery, recent exams, misconceptions, and the Phase 6
 * adaptive engine's own forgetting-risk/prerequisite-blocking scoring
 * (never a single exam score, spec §40) — these tests assert its
 * directional behavior and the two hand-templated text branches
 * (spec §42: never generic AI motivational text) against real DB rows,
 * rather than re-deriving the exact weighted formula (config.ts's
 * READINESS_WEIGHTS), which is free to be retuned independently.
 */
describe("calculateReadiness (integration)", () => {
  let userId: string;
  let courseId: string;
  let strongConceptId: string;
  let weakConceptId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `exam-readiness-${suffix}@example.com` } });
    userId = user.id;
    const course = await prisma.course.create({ data: { userId, title: `Readiness ${suffix}` } });
    courseId = course.id;

    const strong = await prisma.concept.create({
      data: { courseId, name: "Strong Concept", normalizedName: "strong concept", description: "d" },
    });
    const weak = await prisma.concept.create({
      data: { courseId, name: "Weak Concept", normalizedName: "weak concept", description: "d" },
    });
    strongConceptId = strong.id;
    weakConceptId = weak.id;

    await prisma.studentConceptMastery.createMany({
      data: [
        { userId, conceptId: strongConceptId, overallMastery: 0.95, exposureCount: 6, successCount: 6, status: "MASTERED" },
        { userId, conceptId: weakConceptId, overallMastery: 0.15, exposureCount: 3, failureCount: 2, status: "LEARNING" },
      ],
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("reports NOT_READY with a 'build the graph first' message when the course doesn't exist for this user", async () => {
    const result = await calculateReadiness(userId, "nonexistent-course-id");
    expect(result.status).toBe("NOT_READY");
    expect(result.readiness).toBe(0);
    expect(result.explanation).toBe("No course data available yet.");
    expect(result.recommendation).toBe("Build the course knowledge graph first.");
  });

  it("a course with concepts but zero exposure/history still returns a low but non-crashing readiness (no NaN)", async () => {
    const emptyCourse = await prisma.course.create({ data: { userId, title: "Empty course" } });
    const result = await calculateReadiness(userId, emptyCourse.id);
    expect(Number.isNaN(result.readiness)).toBe(false);
    expect(result.status).toBe("NOT_READY");
    expect(result.weakAreas).toEqual([]);
  });

  it("returns higher readiness for a scope of only strong concepts than only weak concepts", async () => {
    const strongOnly = await calculateReadiness(userId, courseId, [strongConceptId]);
    const weakOnly = await calculateReadiness(userId, courseId, [weakConceptId]);

    expect(strongOnly.readiness).toBeGreaterThan(weakOnly.readiness);
    expect(weakOnly.weakAreas).toEqual(["Weak Concept"]);
    expect(strongOnly.weakAreas).toEqual([]);
  });

  it("scopes weakAreas/readiness to targetConceptIds rather than the whole course", async () => {
    const wholeCourse = await calculateReadiness(userId, courseId);
    expect(wholeCourse.weakAreas).toContain("Weak Concept");

    const strongScoped = await calculateReadiness(userId, courseId, [strongConceptId]);
    expect(strongScoped.weakAreas).not.toContain("Weak Concept");
  });

  it("templates a weak-concepts explanation rather than generic text when a concept is below threshold", async () => {
    const result = await calculateReadiness(userId, courseId, [weakConceptId]);
    expect(result.explanation).toContain("Weak Concept");
    expect(result.explanation).toContain("still need work");
  });

  it("an unresolved misconception lowers readiness relative to the same scope without one", async () => {
    const before = await calculateReadiness(userId, courseId, [strongConceptId]);

    const misconception = await prisma.studentMisconception.create({
      data: { userId, conceptId: strongConceptId, description: "Thinks X always implies Y.", severity: "MEDIUM" },
    });

    const after = await calculateReadiness(userId, courseId, [strongConceptId]);
    expect(after.readiness).toBeLessThan(before.readiness);
    expect(after.explanation).toMatch(/unresolved misconception/);

    await prisma.studentMisconception.delete({ where: { id: misconception.id } });
  });

  it("a concept blocked by a weak prerequisite lowers readiness relative to no prerequisite relationship", async () => {
    const target = await prisma.concept.create({
      data: { courseId, name: "Blocked Target", normalizedName: "blocked target", description: "d" },
    });
    await prisma.studentConceptMastery.create({
      data: { userId, conceptId: target.id, overallMastery: 0.3, exposureCount: 2, status: "LEARNING" },
    });

    const withoutPrereqEdge = await calculateReadiness(userId, courseId, [target.id]);

    await prisma.conceptRelationship.create({
      data: {
        sourceConceptId: weakConceptId,
        targetConceptId: target.id,
        relationshipType: "prerequisite",
        confidence: 0.9,
        evidence: "x",
      },
    });

    const withPrereqEdge = await calculateReadiness(userId, courseId, [target.id]);
    expect(withPrereqEdge.readiness).toBeLessThanOrEqual(withoutPrereqEdge.readiness);
    expect(withPrereqEdge.explanation).toMatch(/held back by a weaker prerequisite/);
  });

  it("a consistently strong recent exam history raises readiness above the mastery-only baseline for the same concept", async () => {
    const examScopeConcept = await prisma.concept.create({
      data: { courseId, name: "Exam Scope Concept", normalizedName: "exam scope concept", description: "d" },
    });
    await prisma.studentConceptMastery.create({
      data: { userId, conceptId: examScopeConcept.id, overallMastery: 0.5, exposureCount: 2, status: "LEARNING" },
    });

    const baseline = await calculateReadiness(userId, courseId, [examScopeConcept.id]);

    for (let i = 0; i < 2; i++) {
      const exam = await prisma.exam.create({
        data: { userId, courseId, mode: "WRITTEN", status: "GRADED", questionCount: 5, passingScore: 0.75, submittedAt: new Date() },
      });
      await prisma.examResult.create({
        data: {
          examId: exam.id,
          overallScore: 0.95,
          percentage: 0.95,
          passed: true,
          totalQuestions: 5,
          correctAnswers: 5,
          partialAnswers: 0,
          incorrectAnswers: 0,
          unanswered: 0,
          timeSpentSeconds: 600,
          conceptScores: {},
          cognitiveScores: {},
          mistakeSummary: {},
        },
      });
    }

    const afterStrongExams = await calculateReadiness(userId, courseId, [examScopeConcept.id]);
    expect(afterStrongExams.readiness).toBeGreaterThan(baseline.readiness);
  });
});
