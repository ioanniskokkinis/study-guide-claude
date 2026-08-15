import { prisma } from "@/lib/db/prisma";
import { getNextLearningAction } from "@/lib/learning/adaptive-engine";
import { calculateReadiness } from "./exam-readiness";
import { analyzeExamMistakes, type ClassifiedMistake } from "./mistake-analyzer";
import type { CognitiveLevelValue, ExamMistakeCategoryValue, NextBestExamActionResult, ReadinessOutput } from "./types";

/**
 * ExamEngine (spec §2): the composable named steps — never one opaque
 * "gradeAndDecideEverything()" function. Each of these is independently
 * callable and testable; exam-orchestrator.ts sequences them and owns the
 * side effects (persistence, session lifecycle) that don't belong in a
 * decision function.
 */

export interface ExamResultAggregate {
  overallScore: number;
  percentage: number;
  passed: boolean;
  totalQuestions: number;
  correctAnswers: number;
  partialAnswers: number;
  incorrectAnswers: number;
  unanswered: number;
  timeSpentSeconds: number;
  conceptScores: Record<string, { name: string; score: number; questionCount: number }>;
  cognitiveScores: Record<CognitiveLevelValue, number>;
  mistakeSummary: {
    totalMistakes: number;
    byCategory: Partial<Record<ExamMistakeCategoryValue, number>>;
    prerequisiteFailures: number;
  };
}

/** Aggregates every graded ExamAnswer into the exam's result (spec §37-39) — every number here is derived from real evidence, never invented. */
export async function calculateExamResult(examId: string, mistakes: ClassifiedMistake[]): Promise<ExamResultAggregate> {
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
  const answers = await prisma.examAnswer.findMany({
    where: { examId },
    include: { question: { select: { conceptId: true, cognitiveLevel: true, points: true, concept: { select: { name: true } } } } },
  });

  const conceptTotals = new Map<string, { name: string; earned: number; possible: number; count: number }>();
  const cognitiveTotals = new Map<CognitiveLevelValue, { earned: number; possible: number }>();

  let correctAnswers = 0;
  let partialAnswers = 0;
  let incorrectAnswers = 0;
  let unanswered = 0;
  let totalPointsEarned = 0;
  let totalPointsPossible = 0;

  for (const answer of answers) {
    const points = answer.question.points;
    const score = answer.score ?? 0;
    totalPointsPossible += points;
    totalPointsEarned += score * points;

    switch (answer.classification) {
      case "CORRECT":
        correctAnswers += 1;
        break;
      case "PARTIALLY_CORRECT":
        partialAnswers += 1;
        break;
      case "INCORRECT":
      case "MISCONCEPTION":
        incorrectAnswers += 1;
        break;
      default:
        unanswered += 1;
    }

    const concept = conceptTotals.get(answer.question.conceptId) ?? { name: answer.question.concept.name, earned: 0, possible: 0, count: 0 };
    concept.earned += score * points;
    concept.possible += points;
    concept.count += 1;
    conceptTotals.set(answer.question.conceptId, concept);

    const cognitive = cognitiveTotals.get(answer.question.cognitiveLevel) ?? { earned: 0, possible: 0 };
    cognitive.earned += score * points;
    cognitive.possible += points;
    cognitiveTotals.set(answer.question.cognitiveLevel, cognitive);
  }

  const conceptScores: ExamResultAggregate["conceptScores"] = {};
  for (const [conceptId, t] of conceptTotals) {
    conceptScores[conceptId] = { name: t.name, score: t.possible > 0 ? t.earned / t.possible : 0, questionCount: t.count };
  }

  const cognitiveScores = {} as Record<CognitiveLevelValue, number>;
  for (const level of ["RECALL", "UNDERSTAND", "APPLY", "ANALYZE", "EVALUATE"] as CognitiveLevelValue[]) {
    const t = cognitiveTotals.get(level);
    cognitiveScores[level] = t && t.possible > 0 ? t.earned / t.possible : 0;
  }

  const byCategory: Partial<Record<ExamMistakeCategoryValue, number>> = {};
  for (const m of mistakes) byCategory[m.category] = (byCategory[m.category] ?? 0) + 1;
  const prerequisiteFailures = mistakes.filter((m) => m.prerequisiteDiagnosis && m.prerequisiteDiagnosis.weakPrerequisites.length > 0).length;

  const percentage = totalPointsPossible > 0 ? totalPointsEarned / totalPointsPossible : 0;
  const timeSpentSeconds =
    exam.startedAt && exam.submittedAt
      ? Math.max(0, Math.floor((exam.submittedAt.getTime() - exam.startedAt.getTime()) / 1000))
      : answers.reduce((sum, a) => sum + a.timeSpentSeconds, 0);

  return {
    overallScore: totalPointsEarned,
    percentage,
    passed: percentage >= exam.passingScore,
    totalQuestions: answers.length,
    correctAnswers,
    partialAnswers,
    incorrectAnswers,
    unanswered,
    timeSpentSeconds,
    conceptScores,
    cognitiveScores,
    mistakeSummary: { totalMistakes: mistakes.length, byCategory, prerequisiteFailures },
  };
}

/** Concepts scoring below the "confirmed" bar — spec §16's "weak areas" for a readiness/post-exam summary. */
export function identifyWeakConcepts(conceptScores: ExamResultAggregate["conceptScores"], threshold = 0.6): string[] {
  return Object.values(conceptScores)
    .filter((c) => c.score < threshold)
    .sort((a, b) => a.score - b.score)
    .map((c) => c.name);
}

/**
 * Post-exam recommendation (spec §44-45) — never "study more." By the time
 * this runs, the exam's evidence has already been recorded into the
 * Student Knowledge Model, so getNextLearningAction() already reflects it;
 * this reuses that decision as the primary signal (spec §13) and only
 * layers exam-specific mistake categories on top to pick among the
 * exam-flavored action variants (TEACH_BACK/SCENARIO_PRACTICE/RETEST) the
 * adaptive engine's own vocabulary doesn't have.
 */
export async function recommendNextAction(params: {
  userId: string;
  courseId: string;
  mistakes: ClassifiedMistake[];
  readiness: ReadinessOutput;
}): Promise<NextBestExamActionResult> {
  const { action } = await getNextLearningAction({ userId: params.userId, courseId: params.courseId });
  const relevantMistake = params.mistakes.find((m) => m.conceptId === action.conceptId);

  if (action.actionType === "PREREQUISITE_REVIEW") {
    return { action: "REVIEW_CONCEPT", conceptId: action.conceptId, conceptName: action.conceptName, reason: action.reason.message };
  }

  if (action.actionType === "REMEDIATION") {
    if (relevantMistake?.category === "APPLICATION_FAILURE") {
      return { action: "SCENARIO_PRACTICE", conceptId: action.conceptId, conceptName: action.conceptName, reason: `${action.conceptName} needs practice applying the concept, not just recalling it.` };
    }
    return { action: "REMEDIATION", conceptId: action.conceptId, conceptName: action.conceptName, reason: action.reason.message };
  }

  if (action.actionType === "CHALLENGE") {
    return { action: "SCENARIO_PRACTICE", conceptId: action.conceptId, conceptName: action.conceptName, reason: action.reason.message };
  }

  if (action.actionType === "REVIEW") {
    return { action: "TEACH_BACK", conceptId: action.conceptId, conceptName: action.conceptName, reason: action.reason.message };
  }

  if (params.readiness.status === "ALMOST_READY" && params.mistakes.length > 0) {
    return { action: "RETEST", conceptId: null, conceptName: null, reason: params.readiness.recommendation };
  }

  return { action: "ACTIVE_RECALL", conceptId: action.conceptId, conceptName: action.conceptName, reason: action.reason.message };
}

export { buildExamBlueprint } from "./exam-blueprint";
export { generateExamFromBlueprint, getOrGenerateExamQuestion } from "./exam-generator";
export { analyzeExamMistakes };
export { calculateReadiness };
