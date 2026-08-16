import type { StudyRoadmapItemAction } from "@/generated/prisma/client";
import { EXAM_MODE_APPROACHING_WITHIN_DAYS, EXAM_MODE_IMMINENT_WITHIN_DAYS } from "./config";

/**
 * Deterministic exam-mode phase (Phase 16 §34) — the closer the roadmap's
 * deadline, the more activity should shift from building understanding
 * toward practice/exam simulation. Reuses the same deadline field every
 * other Phase 16 module reads (`StudyRoadmap.deadline`); does not create a
 * second exam system — biasing which *existing* action
 * (`StudyRoadmapItemAction`, Phase 15) an item gets is all this does. The
 * actual exam itself is still generated/graded entirely by the Phase 8 Exam
 * Engine, unmodified.
 */
export type ExamModePhase = "NONE" | "FAR" | "APPROACHING" | "IMMINENT";

export function examModePhase(deadline: Date | null, now: Date = new Date()): ExamModePhase {
  if (!deadline) return "NONE";
  const daysRemaining = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  if (daysRemaining <= EXAM_MODE_IMMINENT_WITHIN_DAYS) return "IMMINENT";
  if (daysRemaining <= EXAM_MODE_APPROACHING_WITHIN_DAYS) return "APPROACHING";
  return "FAR";
}

/**
 * Biases a mastery-bucket-derived action toward more exam-realistic
 * practice as the deadline approaches. Never overrides LEARN — a concept
 * the student hasn't touched yet still needs to be learned regardless of
 * how close the exam is (spec §34's own "far -> learning + prerequisite
 * building" only applies when the base action already reflects other than
 * LEARN).
 */
export function applyExamModeBias(baseAction: StudyRoadmapItemAction, phase: ExamModePhase, isWeak: boolean): StudyRoadmapItemAction {
  if (baseAction === "LEARN") return baseAction;

  if (phase === "IMMINENT") {
    return isWeak ? "REVIEW" : "EXAM_PRACTICE";
  }
  if (phase === "APPROACHING") {
    return baseAction === "REVIEW" ? "ACTIVE_RECALL" : baseAction;
  }
  return baseAction;
}
