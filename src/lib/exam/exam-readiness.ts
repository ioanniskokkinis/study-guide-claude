import { prisma } from "@/lib/db/prisma";
import { clamp01 } from "@/lib/learning/mastery-engine";
import { getCourseMastery, type ConceptMasterySummary } from "@/lib/services/student-knowledge";
import { getStudentLearningState } from "@/lib/learning/adaptive/student-state";
import { calculateForgettingRiskScore, findPrerequisiteBlock } from "@/lib/learning/adaptive/concept-scoring";
import {
  MAX_MISCONCEPTION_PENALTY,
  MISCONCEPTION_READINESS_PENALTY,
  READINESS_STATUS_THRESHOLDS,
  READINESS_WEIGHTS,
  RECENT_EXAM_WINDOW,
} from "./config";
import type { CognitiveLevelValue, ReadinessOutput, ReadinessStatusValue } from "./types";

/**
 * ExamReadinessEngine (spec §40-42) — deterministic, reuses the Phase 6
 * adaptive engine's own forgetting-risk and prerequisite-blocking scoring
 * rather than a second mastery model (spec §13, §40: "do not use a single
 * exam score"). No Claude calls; the explanation is templated from real
 * numbers, not generated free text (spec §42 — avoid generic AI
 * motivational text).
 */

function statusForReadiness(readiness: number): ReadinessStatusValue {
  if (readiness < READINESS_STATUS_THRESHOLDS.notReady) return "NOT_READY";
  if (readiness < READINESS_STATUS_THRESHOLDS.developing) return "DEVELOPING";
  if (readiness < READINESS_STATUS_THRESHOLDS.almostReady) return "ALMOST_READY";
  if (readiness < READINESS_STATUS_THRESHOLDS.ready) return "READY";
  return "MASTERED";
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function consistencyFromScores(scores: number[]): number {
  if (scores.length < 2) return 0.7; // not enough history to judge — neutral, not punitive.
  const mean = average(scores);
  const variance = average(scores.map((s) => (s - mean) ** 2));
  const stddev = Math.sqrt(variance);
  return clamp01(1 - stddev * 2); // stddev of 0.5 (huge swings) drives consistency to 0.
}

const COGNITIVE_LABELS: Record<CognitiveLevelValue, string> = {
  RECALL: "recall",
  UNDERSTAND: "understanding",
  APPLY: "application",
  ANALYZE: "analysis",
  EVALUATE: "evaluation",
};

function buildExplanation(params: {
  status: ReadinessStatusValue;
  weakConcepts: ConceptMasterySummary[];
  cognitiveScores: Record<CognitiveLevelValue, number> | null;
  misconceptionCount: number;
  blockedCount: number;
}): string {
  if (params.status === "MASTERED") {
    return "You've consistently demonstrated strong, independent performance across this course.";
  }

  const parts: string[] = [];

  if (params.cognitiveScores) {
    const entries = Object.entries(params.cognitiveScores) as Array<[CognitiveLevelValue, number]>;
    const scored = entries.filter(([, v]) => v > 0);
    if (scored.length >= 2) {
      const best = scored.reduce((a, b) => (b[1] > a[1] ? b : a));
      const worst = scored.reduce((a, b) => (b[1] < a[1] ? b : a));
      if (best[0] !== worst[0] && best[1] - worst[1] >= 0.15) {
        parts.push(
          `Your ${COGNITIVE_LABELS[best[0]]} is strong (${Math.round(best[1] * 100)}%), but ${COGNITIVE_LABELS[worst[0]]} questions remain inconsistent (${Math.round(worst[1] * 100)}%).`,
        );
      }
    }
  }

  if (params.weakConcepts.length > 0) {
    const names = params.weakConcepts.slice(0, 3).map((c) => c.conceptName);
    parts.push(`${names.join(", ")} still need work.`);
  }

  if (params.misconceptionCount > 0) {
    parts.push(`${params.misconceptionCount} unresolved misconception${params.misconceptionCount === 1 ? "" : "s"} may be affecting related questions.`);
  }

  if (params.blockedCount > 0) {
    parts.push(`${params.blockedCount} concept${params.blockedCount === 1 ? " is" : "s are"} being held back by a weaker prerequisite.`);
  }

  if (parts.length === 0) {
    parts.push("Performance is still developing across the tested material.");
  }

  return parts.join(" ");
}

function recommendationFor(status: ReadinessStatusValue, weakCount: number): string {
  switch (status) {
    case "NOT_READY":
      return "Focused remediation on your weakest concepts before attempting a full exam.";
    case "DEVELOPING":
      return "Targeted remediation and active recall practice on weak areas.";
    case "ALMOST_READY":
      return weakCount > 0 ? "A short remediation pass, then a targeted retest of the weak areas." : "A targeted retest to confirm consistency.";
    case "READY":
      return "You're ready — a full exam should reliably reflect your understanding.";
    case "MASTERED":
      return "Periodic review to keep this material sharp.";
  }
}

/**
 * Calculates readiness for a course (or a specific set of target concepts,
 * e.g. before a retest) from mastery, recent exam performance, consistency,
 * misconception count, prerequisite health, and forgetting risk — never a
 * single exam score (spec §40).
 */
export async function calculateReadiness(userId: string, courseId: string, targetConceptIds?: string[]): Promise<ReadinessOutput> {
  const [courseMastery, state, recentResults, activeMisconceptions] = await Promise.all([
    getCourseMastery(userId, courseId),
    getStudentLearningState(userId, courseId),
    prisma.exam.findMany({
      where: { userId, courseId, status: "GRADED" },
      orderBy: { submittedAt: "desc" },
      take: RECENT_EXAM_WINDOW,
      include: { result: true },
    }),
    prisma.studentMisconception.count({ where: { userId, resolved: false, concept: { courseId } } }),
  ]);

  if (!courseMastery) {
    return { readiness: 0, status: "NOT_READY", weakAreas: [], recommendation: "Build the course knowledge graph first.", explanation: "No course data available yet." };
  }

  const scopedConcepts =
    targetConceptIds && targetConceptIds.length > 0
      ? courseMastery.concepts.filter((c) => targetConceptIds.includes(c.conceptId))
      : courseMastery.concepts;

  const withEvidence = scopedConcepts.filter((c) => c.exposureCount > 0);
  const mastery = average((withEvidence.length > 0 ? withEvidence : scopedConcepts).map((c) => c.overallMastery));

  const recentPercentages = recentResults.map((r) => r.result?.percentage).filter((p): p is number => p != null);
  const recentExamPerformance = recentPercentages.length > 0 ? average(recentPercentages) : mastery;
  const consistency = consistencyFromScores(recentPercentages);

  const forgettingRisk = state ? average(scopedConcepts.map((c) => calculateForgettingRiskScore(c.conceptId, state))) : 0;

  const blockedConcepts = state ? scopedConcepts.filter((c) => findPrerequisiteBlock(c.conceptId, state).blocked) : [];
  const prerequisiteHealth = scopedConcepts.length > 0 ? 1 - blockedConcepts.length / scopedConcepts.length : 1;

  const misconceptionPenalty = Math.min(MAX_MISCONCEPTION_PENALTY, activeMisconceptions * MISCONCEPTION_READINESS_PENALTY);

  const readiness = clamp01(
    mastery * READINESS_WEIGHTS.mastery +
      recentExamPerformance * READINESS_WEIGHTS.recentExamPerformance +
      consistency * READINESS_WEIGHTS.consistency +
      prerequisiteHealth * READINESS_WEIGHTS.prerequisiteHealth +
      (1 - forgettingRisk) * READINESS_WEIGHTS.forgettingRisk -
      misconceptionPenalty,
  );

  const status = statusForReadiness(readiness);
  const weakConcepts = scopedConcepts.filter((c) => c.overallMastery < 0.5 || c.exposureCount === 0).sort((a, b) => a.overallMastery - b.overallMastery);

  const latestCognitiveScores =
    recentResults[0]?.result?.cognitiveScores && typeof recentResults[0].result.cognitiveScores === "object"
      ? (recentResults[0].result.cognitiveScores as Record<CognitiveLevelValue, number>)
      : null;

  return {
    readiness,
    status,
    weakAreas: weakConcepts.slice(0, 5).map((c) => c.conceptName),
    recommendation: recommendationFor(status, weakConcepts.length),
    explanation: buildExplanation({
      status,
      weakConcepts,
      cognitiveScores: latestCognitiveScores,
      misconceptionCount: activeMisconceptions,
      blockedCount: blockedConcepts.length,
    }),
  };
}
