import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { calculateExamResult, identifyWeakConcepts } from "@/lib/exam/exam-engine";
import type { ClassifiedMistake } from "@/lib/exam/mistake-analyzer";

/**
 * Phase 19 §19.11 — exam-engine.ts had zero dedicated test coverage before
 * this file (flagged by the Phase 19 audit as one of the two deterministic
 * cores driving student-facing behavior, alongside tutor-engine.ts).
 * calculateExamResult() is exercised indirectly through
 * exam-orchestrator.test.ts's end-to-end flows, but never asserted against
 * directly-known input numbers — these tests do that.
 */

describe("identifyWeakConcepts", () => {
  const conceptScores = {
    a: { name: "Alpha", score: 0.9, questionCount: 3 },
    b: { name: "Beta", score: 0.3, questionCount: 2 },
    c: { name: "Gamma", score: 0.55, questionCount: 4 },
    d: { name: "Delta", score: 0.1, questionCount: 1 },
  };

  it("returns concepts below the default 0.6 threshold, weakest first", () => {
    expect(identifyWeakConcepts(conceptScores)).toEqual(["Delta", "Beta", "Gamma"]);
  });

  it("respects a custom threshold", () => {
    expect(identifyWeakConcepts(conceptScores, 0.2)).toEqual(["Delta"]);
  });

  it("returns an empty array when every concept clears the threshold", () => {
    expect(identifyWeakConcepts({ a: { name: "Alpha", score: 0.9, questionCount: 1 } })).toEqual([]);
  });

  it("returns an empty array for no concepts at all", () => {
    expect(identifyWeakConcepts({})).toEqual([]);
  });
});

describe("calculateExamResult (integration)", () => {
  let userId: string;
  let courseId: string;
  let conceptAId: string;
  let conceptBId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `exam-engine-${suffix}@example.com` } });
    userId = user.id;
    const course = await prisma.course.create({ data: { userId, title: `Exam engine ${suffix}` } });
    courseId = course.id;

    const conceptA = await prisma.concept.create({
      data: { courseId, name: "Alpha", normalizedName: "alpha", description: "Alpha description." },
    });
    const conceptB = await prisma.concept.create({
      data: { courseId, name: "Beta", normalizedName: "beta", description: "Beta description." },
    });
    conceptAId = conceptA.id;
    conceptBId = conceptB.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  async function seedGradedExam(params: {
    passingScore: number;
    startedAt: Date;
    submittedAt: Date;
    answers: Array<{
      conceptId: string;
      cognitiveLevel: "RECALL" | "UNDERSTAND" | "APPLY" | "ANALYZE" | "EVALUATE";
      points: number;
      score: number | null;
      classification: "CORRECT" | "PARTIALLY_CORRECT" | "INCORRECT" | "MISCONCEPTION" | "UNANSWERED" | null;
    }>;
  }) {
    const exam = await prisma.exam.create({
      data: {
        userId,
        courseId,
        mode: "WRITTEN",
        status: "SUBMITTED",
        questionCount: params.answers.length,
        passingScore: params.passingScore,
        startedAt: params.startedAt,
        submittedAt: params.submittedAt,
      },
    });

    for (let i = 0; i < params.answers.length; i++) {
      const a = params.answers[i];
      const question = await prisma.examQuestion.create({
        data: {
          examId: exam.id,
          conceptId: a.conceptId,
          questionType: "SHORT_ANSWER",
          cognitiveLevel: a.cognitiveLevel,
          position: i,
          prompt: `Question ${i}?`,
          points: a.points,
        },
      });
      await prisma.examAnswer.create({
        data: {
          examId: exam.id,
          questionId: question.id,
          userId,
          score: a.score,
          classification: a.classification,
          submittedAt: a.classification === "UNANSWERED" || a.classification === null ? null : params.submittedAt,
        },
      });
    }

    return exam;
  }

  it("aggregates score, pass/fail, per-concept and per-cognitive-level breakdowns from real ExamAnswer rows", async () => {
    const startedAt = new Date("2026-01-01T10:00:00Z");
    const submittedAt = new Date("2026-01-01T10:20:00Z");
    const exam = await seedGradedExam({
      passingScore: 0.75,
      startedAt,
      submittedAt,
      answers: [
        { conceptId: conceptAId, cognitiveLevel: "RECALL", points: 1, score: 1, classification: "CORRECT" },
        { conceptId: conceptAId, cognitiveLevel: "APPLY", points: 1, score: 0.5, classification: "PARTIALLY_CORRECT" },
        { conceptId: conceptBId, cognitiveLevel: "RECALL", points: 1, score: 0, classification: "INCORRECT" },
        { conceptId: conceptBId, cognitiveLevel: "APPLY", points: 1, score: null, classification: "UNANSWERED" },
      ],
    });

    const result = await calculateExamResult(exam.id, []);

    expect(result.totalQuestions).toBe(4);
    expect(result.correctAnswers).toBe(1);
    expect(result.partialAnswers).toBe(1);
    expect(result.incorrectAnswers).toBe(1);
    expect(result.unanswered).toBe(1);

    // (1 + 0.5 + 0 + 0) / 4 points possible = 0.375
    expect(result.percentage).toBeCloseTo(0.375, 5);
    expect(result.passed).toBe(false);

    expect(result.conceptScores[conceptAId].score).toBeCloseTo(0.75, 5); // (1 + 0.5) / 2
    expect(result.conceptScores[conceptAId].questionCount).toBe(2);
    expect(result.conceptScores[conceptBId].score).toBeCloseTo(0, 5); // (0 + 0) / 2
    expect(result.conceptScores[conceptBId].questionCount).toBe(2);

    expect(result.cognitiveScores.RECALL).toBeCloseTo(0.5, 5); // (1 + 0) / 2
    expect(result.cognitiveScores.APPLY).toBeCloseTo(0.25, 5); // (0.5 + 0) / 2
    expect(result.cognitiveScores.EVALUATE).toBe(0); // never tested -> 0, not NaN

    expect(result.timeSpentSeconds).toBe(1200); // 20 minutes, derived from startedAt/submittedAt
  });

  it("passes when the percentage meets the exam's own passingScore", async () => {
    const startedAt = new Date("2026-01-02T10:00:00Z");
    const submittedAt = new Date("2026-01-02T10:10:00Z");
    const exam = await seedGradedExam({
      passingScore: 0.5,
      startedAt,
      submittedAt,
      answers: [{ conceptId: conceptAId, cognitiveLevel: "RECALL", points: 1, score: 1, classification: "CORRECT" }],
    });

    const result = await calculateExamResult(exam.id, []);
    expect(result.percentage).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("folds the given classified mistakes into mistakeSummary.byCategory and prerequisiteFailures", async () => {
    const startedAt = new Date("2026-01-03T10:00:00Z");
    const submittedAt = new Date("2026-01-03T10:05:00Z");
    const exam = await seedGradedExam({
      passingScore: 0.75,
      startedAt,
      submittedAt,
      answers: [{ conceptId: conceptBId, cognitiveLevel: "RECALL", points: 1, score: 0, classification: "INCORRECT" }],
    });

    const mistakes: ClassifiedMistake[] = [
      {
        questionId: "q1",
        conceptId: conceptBId,
        category: "PREREQUISITE_FAILURE",
        severity: "HIGH",
        description: "Weak prerequisite.",
        prerequisiteDiagnosis: {
          failedConceptId: conceptBId,
          failedConceptName: "Beta",
          weakPrerequisites: [{ conceptId: conceptAId, conceptName: "Alpha", mastery: 0.2, depth: 1 }],
        },
      },
      {
        questionId: "q2",
        conceptId: conceptBId,
        category: "CARELESS_ERROR",
        severity: "LOW",
        description: "Slip.",
        prerequisiteDiagnosis: null,
      },
    ];

    const result = await calculateExamResult(exam.id, mistakes);
    expect(result.mistakeSummary.totalMistakes).toBe(2);
    expect(result.mistakeSummary.byCategory.PREREQUISITE_FAILURE).toBe(1);
    expect(result.mistakeSummary.byCategory.CARELESS_ERROR).toBe(1);
    expect(result.mistakeSummary.prerequisiteFailures).toBe(1);
  });

  it("falls back to summed per-answer time when the exam has no startedAt/submittedAt", async () => {
    const exam = await prisma.exam.create({
      data: { userId, courseId, mode: "WRITTEN", status: "SUBMITTED", questionCount: 1, passingScore: 0.75 },
    });
    const question = await prisma.examQuestion.create({
      data: { examId: exam.id, conceptId: conceptAId, questionType: "SHORT_ANSWER", cognitiveLevel: "RECALL", position: 0, prompt: "Q?", points: 1 },
    });
    await prisma.examAnswer.create({
      data: { examId: exam.id, questionId: question.id, userId, score: 1, classification: "CORRECT", timeSpentSeconds: 42 },
    });

    const result = await calculateExamResult(exam.id, []);
    expect(result.timeSpentSeconds).toBe(42);
  });
});
