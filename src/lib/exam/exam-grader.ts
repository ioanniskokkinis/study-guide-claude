import { clamp01 } from "@/lib/learning/mastery-engine";
import { CLASSIFICATION_SCORE_BANDS, EXAM_HINT_EVIDENCE_DISCOUNT, RUBRIC_CRITERION_WEIGHTS } from "./config";
import type { AnswerGrading, ExamAnswerClassificationValue } from "./types";

/**
 * Deterministic grading (spec §22-23): Claude may return per-criterion
 * scores or option selections, but the final score and pass/fail decision
 * always come from plain arithmetic here — never trusted directly from a
 * model. Multiple-choice/true-false/multi-select are graded without any
 * Claude call at all (spec §60).
 */

export interface GradedAnswer {
  classification: ExamAnswerClassificationValue;
  score: number;
}

/** MULTIPLE_CHOICE / TRUE_FALSE: exactly one correct option, all-or-nothing. */
export function gradeSingleSelect(selectedOptionIds: string[], correctOptionIds: string[]): GradedAnswer {
  if (selectedOptionIds.length === 0) return { classification: "UNANSWERED", score: 0 };
  const correct = selectedOptionIds.length === 1 && correctOptionIds.includes(selectedOptionIds[0]);
  return correct ? { classification: "CORRECT", score: 1 } : { classification: "INCORRECT", score: 0 };
}

/** MULTI_SELECT: partial credit — (correctly selected - incorrectly selected) / total correct, never negative. */
export function gradeMultiSelect(selectedOptionIds: string[], correctOptionIds: string[]): GradedAnswer {
  if (selectedOptionIds.length === 0) return { classification: "UNANSWERED", score: 0 };
  if (correctOptionIds.length === 0) return { classification: "UNANSWERED", score: 0 };

  const correctSet = new Set(correctOptionIds);
  const correctlySelected = selectedOptionIds.filter((id) => correctSet.has(id)).length;
  const incorrectlySelected = selectedOptionIds.filter((id) => !correctSet.has(id)).length;
  const score = clamp01((correctlySelected - incorrectlySelected) / correctOptionIds.length);

  return { classification: classifyFromScore(score), score };
}

export function classifyFromScore(score: number): ExamAnswerClassificationValue {
  if (score >= CLASSIFICATION_SCORE_BANDS.correct) return "CORRECT";
  if (score >= CLASSIFICATION_SCORE_BANDS.partiallyCorrect) return "PARTIALLY_CORRECT";
  return "INCORRECT";
}

/**
 * Combines Claude's per-criterion rubric scores into one deterministic
 * final score (spec §22-23) — the weights are fixed constants
 * (config.ts), not something Claude influences.
 */
export function computeFinalScoreFromCriteria(criteria: AnswerGrading["criteria"]): number {
  return clamp01(
    criteria.correctness * RUBRIC_CRITERION_WEIGHTS.correctness +
      criteria.completeness * RUBRIC_CRITERION_WEIGHTS.completeness +
      criteria.reasoning * RUBRIC_CRITERION_WEIGHTS.reasoning +
      criteria.application * RUBRIC_CRITERION_WEIGHTS.application +
      criteria.conceptualUnderstanding * RUBRIC_CRITERION_WEIGHTS.conceptualUnderstanding,
  );
}

/**
 * Grades a Claude-evaluated (open-ended/short-answer/problem-solving/
 * scenario/teach-back/oral) answer: the classification Claude proposed is
 * kept for MISCONCEPTION/UNANSWERED (those aren't derivable from a numeric
 * score alone), but the *score* — and the classification for every other
 * case — is recomputed deterministically from the criteria (spec §23), so
 * a model that says "CORRECT" with low criteria scores can never inflate
 * the grade.
 */
export function gradeFromRubric(answerText: string, grading: AnswerGrading): GradedAnswer {
  if (answerText.trim().length === 0) return { classification: "UNANSWERED", score: 0 };

  const score = computeFinalScoreFromCriteria(grading.criteria);
  if (grading.classification === "MISCONCEPTION") return { classification: "MISCONCEPTION", score };
  return { classification: classifyFromScore(score), score };
}

/**
 * The evidence weight a hinted correct answer contributes to the Student
 * Knowledge Model (spec §15) — the exam's own displayed score is
 * unaffected; only what reaches recordLearningOutcome() is discounted.
 * A revealed answer contributes none at all (returns null) — mirrors
 * Phase 7's "reveal produces no independent evidence" principle.
 */
export function evidenceScoreForExamAnswer(rawScore: number, hintsUsed: number, revealedAnswer: boolean): number | null {
  if (revealedAnswer) return null;
  if (hintsUsed > 0) return clamp01(rawScore * EXAM_HINT_EVIDENCE_DISCOUNT);
  return rawScore;
}
