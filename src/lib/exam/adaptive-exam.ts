import { clampDifficulty } from "@/lib/learning/difficulty-engine";
import { findPrerequisiteBlock } from "@/lib/learning/adaptive/concept-scoring";
import type { StudentLearningState } from "@/lib/learning/adaptive/student-state";
import { ADAPTIVE_DECREASE_THRESHOLD, ADAPTIVE_INCREASE_THRESHOLD } from "./config";
import { assignCognitiveLevels } from "./exam-generator";
import type { CognitiveLevelValue, ExamAnswerClassificationValue, ExamBlueprint } from "./types";

/**
 * AdaptiveExamEngine (spec §12-13): difficulty and concept selection react
 * question-to-question, reusing the Phase 6 adaptive engine's own
 * prerequisite-blocking detection rather than a second mastery/prerequisite
 * model. Deliberately does NOT reuse difficulty-engine.ts's
 * computeNextDifficulty() — that function intentionally holds steady below
 * two data points to smooth noise across an Active Recall session, while
 * an adaptive exam must react after every single question (spec §12's own
 * worked example adjusts on question 2, 3, and 4) — but it does reuse
 * clampDifficulty() so both stay within the same [1,5] bound.
 */

export interface PlannedStep {
  conceptId: string;
  conceptName: string;
  cognitiveLevel: CognitiveLevelValue;
}

export interface AdaptiveStep extends PlannedStep {
  difficulty: number;
  reason: "PLANNED" | "DIAGNOSTIC_FOLLOWUP" | "PREREQUISITE_CHECK";
}

export interface LastAdaptiveAnswer {
  conceptId: string;
  conceptName: string;
  classification: ExamAnswerClassificationValue;
  score: number;
}

/** Immediate, per-question difficulty reaction (spec §12) — not smoothed. */
export function nextAdaptiveDifficulty(currentDifficulty: number, lastScore: number | null): number {
  if (lastScore == null) return clampDifficulty(currentDifficulty);
  if (lastScore >= ADAPTIVE_INCREASE_THRESHOLD) return clampDifficulty(currentDifficulty + 1);
  if (lastScore < ADAPTIVE_DECREASE_THRESHOLD) return clampDifficulty(currentDifficulty - 1);
  return clampDifficulty(currentDifficulty);
}

/** Flattens the blueprint into an ordered plan of (concept, cognitive level) steps — the adaptive engine consumes from this in order except when a diagnostic/prerequisite detour is triggered. */
export function planAdaptiveSequence(blueprint: ExamBlueprint): PlannedStep[] {
  const steps: PlannedStep[] = [];
  for (const entry of blueprint.entries) {
    const levels = assignCognitiveLevels(entry.questionCount, entry.cognitiveDistribution as Record<CognitiveLevelValue, number>);
    for (const cognitiveLevel of levels) {
      steps.push({ conceptId: entry.conceptId, conceptName: entry.conceptName, cognitiveLevel });
    }
  }
  return steps;
}

/**
 * Decides the next adaptive-exam question (spec §12 example flow):
 * - A wrong answer whose concept is prerequisite-blocked pivots to
 *   checking that prerequisite directly (spec's "Q5 -> prerequisite
 *   check"), reusing findPrerequisiteBlock() rather than re-deriving it.
 * - A wrong answer with no prerequisite block instead asks an easier,
 *   lower-cognitive-level diagnostic follow-up on the SAME concept (spec's
 *   "Q4 -> Medium diagnostic") to isolate what actually went wrong.
 * - Otherwise, continues down the planned blueprint sequence.
 * Returns null once the plan is exhausted and no detour is triggered —
 * the exam is complete.
 */
export function nextAdaptiveStep(params: {
  state: StudentLearningState;
  plannedSteps: PlannedStep[];
  consumedCount: number;
  lastAnswer: LastAdaptiveAnswer | null;
  currentDifficulty: number;
}): AdaptiveStep | null {
  const nextDifficulty = nextAdaptiveDifficulty(params.currentDifficulty, params.lastAnswer?.score ?? null);

  if (params.lastAnswer && (params.lastAnswer.classification === "INCORRECT" || params.lastAnswer.classification === "MISCONCEPTION")) {
    const block = findPrerequisiteBlock(params.lastAnswer.conceptId, params.state);
    if (block.blocked && block.blockingConceptId) {
      return {
        conceptId: block.blockingConceptId,
        conceptName: block.blockingConceptName ?? "a prerequisite",
        cognitiveLevel: "RECALL",
        difficulty: Math.max(1, nextDifficulty - 1),
        reason: "PREREQUISITE_CHECK",
      };
    }

    return {
      conceptId: params.lastAnswer.conceptId,
      conceptName: params.lastAnswer.conceptName,
      cognitiveLevel: "UNDERSTAND",
      difficulty: Math.max(1, nextDifficulty - 1),
      reason: "DIAGNOSTIC_FOLLOWUP",
    };
  }

  const next = params.plannedSteps[params.consumedCount];
  if (!next) return null;
  return { ...next, difficulty: nextDifficulty, reason: "PLANNED" };
}
