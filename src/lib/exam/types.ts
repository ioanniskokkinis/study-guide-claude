import { z } from "zod";

/**
 * Shared vocabulary for the Exam & Assessment Engine (Phase 8). Same
 * convention as Phase 6/7: plain `as const` arrays double as both the
 * TypeScript union and the Zod enum, and every structured value that
 * crosses the Claude boundary is validated before anything downstream
 * trusts it (spec §59).
 */

export const EXAM_MODES = ["WRITTEN", "ORAL", "SCENARIO", "ADAPTIVE"] as const;
export type ExamModeValue = (typeof EXAM_MODES)[number];

export const EXAM_STATUSES = ["CREATED", "ACTIVE", "PAUSED", "SUBMITTED", "GRADED", "EXPIRED", "ABANDONED"] as const;
export type ExamStatusValue = (typeof EXAM_STATUSES)[number];

export const EXAM_QUESTION_TYPES = [
  "MULTIPLE_CHOICE",
  "MULTI_SELECT",
  "TRUE_FALSE",
  "SHORT_ANSWER",
  "OPEN_ENDED",
  "PROBLEM_SOLVING",
  "SCENARIO",
  "TEACH_BACK",
] as const;
export type ExamQuestionTypeValue = (typeof EXAM_QUESTION_TYPES)[number];

/** Question types graded deterministically — Claude is never called for scoring these (spec §60). */
export const AUTO_GRADED_TYPES: ExamQuestionTypeValue[] = ["MULTIPLE_CHOICE", "MULTI_SELECT", "TRUE_FALSE"];

export const COGNITIVE_LEVELS = ["RECALL", "UNDERSTAND", "APPLY", "ANALYZE", "EVALUATE"] as const;
export type CognitiveLevelValue = (typeof COGNITIVE_LEVELS)[number];

export const EXAM_ANSWER_CLASSIFICATIONS = ["CORRECT", "PARTIALLY_CORRECT", "INCORRECT", "MISCONCEPTION", "UNANSWERED"] as const;
export type ExamAnswerClassificationValue = (typeof EXAM_ANSWER_CLASSIFICATIONS)[number];

export const EXAM_MISTAKE_CATEGORIES = [
  "KNOWLEDGE_GAP",
  "MISCONCEPTION",
  "RECALL_FAILURE",
  "REASONING_FAILURE",
  "APPLICATION_FAILURE",
  "PREREQUISITE_FAILURE",
  "CARELESS_ERROR",
  "INCOMPLETE_ANSWER",
  "TIME_PRESSURE",
  "UNKNOWN",
] as const;
export type ExamMistakeCategoryValue = (typeof EXAM_MISTAKE_CATEGORIES)[number];

export const EXAM_CONFIDENCE_LEVELS = ["CONFIDENT", "UNSURE", "GUESSING"] as const;
export type ExamConfidenceLevelValue = (typeof EXAM_CONFIDENCE_LEVELS)[number];

export const READINESS_STATUSES = ["NOT_READY", "DEVELOPING", "ALMOST_READY", "READY", "MASTERED"] as const;
export type ReadinessStatusValue = (typeof READINESS_STATUSES)[number];

export const NEXT_BEST_EXAM_ACTIONS = [
  "REVIEW_CONCEPT",
  "ACTIVE_RECALL",
  "REMEDIATION",
  "TEACH_BACK",
  "SCENARIO_PRACTICE",
  "RETEST",
] as const;
export type NextBestExamActionValue = (typeof NEXT_BEST_EXAM_ACTIONS)[number];

// ---------------------------------------------------------------------------
// ExamConfig (spec §4) — input to exam creation.
// ---------------------------------------------------------------------------

export interface ExamConfig {
  courseId: string;
  userId: string;
  mode: ExamModeValue;
  questionCount: number;
  durationMinutes: number;
  /** "ADAPTIVE" lets adaptive-exam.ts adjust difficulty question-to-question; a fixed 1-5 pins every question at that level. */
  difficulty: number | "ADAPTIVE";
  allowHints: boolean;
  allowSources: boolean;
  passingScore: number;
  /** Explicit concept scope (e.g. a retest) — omit/empty for "whole course via the blueprint". */
  targetConceptIds?: string[];
  /** Overrides for exam-blueprint.ts's default ratios (spec §11) — never hardcoded, always overridable per exam. */
  coverage?: {
    diagnosticRatios?: { strong: number; medium: number; weak: number };
    cognitiveDistribution?: Partial<Record<CognitiveLevelValue, number>>;
  };
  isRetest?: boolean;
}

// ---------------------------------------------------------------------------
// ExamBlueprint (spec §5-6, §10-11)
// ---------------------------------------------------------------------------

export interface ExamBlueprintEntry {
  conceptId: string;
  conceptName: string;
  /** 0-1 share of the exam's total question budget. */
  weight: number;
  questionCount: number;
  tier: "strong" | "medium" | "weak";
  /** How this concept's questionCount should split across cognitive levels. */
  cognitiveDistribution: Partial<Record<CognitiveLevelValue, number>>;
}

export interface ExamBlueprint {
  entries: ExamBlueprintEntry[];
  totalQuestions: number;
  diagnosticRatios: { strong: number; medium: number; weak: number };
  cognitiveDistribution: Record<CognitiveLevelValue, number>;
}

// ---------------------------------------------------------------------------
// Claude-facing structured outputs — every field validated with Zod before
// the application trusts it (spec §59). Descriptions are short, concise
// strings; nothing here is raw chain-of-thought (spec §21).
// ---------------------------------------------------------------------------

const OptionSchema = z.object({
  id: z.string().min(1).max(10),
  text: z.string().min(1).max(300),
});

/**
 * One flexible schema covering every exam question type (spec §7) rather
 * than eight near-identical ones. `canGenerate: false` is a first-class
 * refusal (mirrors question-generation.ts, spec §9) when the source
 * material can't support a grounded question.
 */
export const ExamQuestionGenerationSchema = z
  .object({
    canGenerate: z.boolean(),
    refusalReason: z.string().max(500).optional(),
    prompt: z.string().min(10).max(1500).optional(),
    /** MULTIPLE_CHOICE/MULTI_SELECT/TRUE_FALSE only. */
    options: z.array(OptionSchema).max(6).optional(),
    /** MULTIPLE_CHOICE/MULTI_SELECT/TRUE_FALSE only — option id(s) from `options` that are correct. */
    correctOptionIds: z.array(z.string()).max(6).optional(),
    /** SHORT_ANSWER/OPEN_ENDED/PROBLEM_SOLVING/SCENARIO/TEACH_BACK reference answer. */
    expectedAnswer: z.string().min(1).max(2000).optional(),
    rubric: z.array(z.string().min(1).max(300)).max(6).optional(),
    /** SCENARIO only. */
    scenario: z
      .object({
        context: z.string().max(1000),
        objective: z.string().max(400),
        constraints: z.array(z.string().max(300)).max(6),
        availableInformation: z.array(z.string().max(300)).max(6),
      })
      .optional(),
    sourceChunkIds: z.array(z.string().min(1)).max(5).optional(),
  })
  .refine((data) => data.canGenerate === false || !!data.prompt, {
    message: "prompt is required when canGenerate is true",
  });
export type ExamQuestionGenerationOutput = z.infer<typeof ExamQuestionGenerationSchema>;

/**
 * Unified grading schema for every non-auto-graded question type (open-
 * ended, short answer, problem solving, scenario, teach-back, oral) — spec
 * §21 example plus rubric criteria (spec §22). Claude returns per-criterion
 * scores only; the backend computes the deterministic final score
 * (exam-grader.ts) — Claude never decides the grade (spec §23).
 */
export const AnswerGradingSchema = z.object({
  classification: z.enum(EXAM_ANSWER_CLASSIFICATIONS),
  criteria: z.object({
    correctness: z.number().min(0).max(1),
    completeness: z.number().min(0).max(1),
    reasoning: z.number().min(0).max(1),
    application: z.number().min(0).max(1),
    conceptualUnderstanding: z.number().min(0).max(1),
  }),
  missingConcepts: z.array(z.string().max(150)).max(6),
  misconceptions: z.array(z.string().max(300)).max(3),
  /** Null unless classification is MISCONCEPTION. */
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).nullable(),
  feedback: z.string().max(500),
});
export type AnswerGrading = z.infer<typeof AnswerGradingSchema>;

/** Oral examiner's next question/follow-up (spec §28-31) — one message, never a teaching explanation. */
export const OralExaminerMessageSchema = z.object({
  message: z.string().min(1).max(400),
});
export type OralExaminerMessage = z.infer<typeof OralExaminerMessageSchema>;

// ---------------------------------------------------------------------------
// Readiness (spec §40-42) and post-exam recommendation (spec §44)
// ---------------------------------------------------------------------------

export interface ReadinessOutput {
  readiness: number;
  status: ReadinessStatusValue;
  weakAreas: string[];
  recommendation: string;
  explanation: string;
}

export interface NextBestExamActionResult {
  action: NextBestExamActionValue;
  conceptId: string | null;
  conceptName: string | null;
  reason: string;
}

// ---------------------------------------------------------------------------
// Mistake analysis (spec §24-27)
// ---------------------------------------------------------------------------

export interface PrerequisiteDiagnosis {
  failedConceptId: string;
  failedConceptName: string;
  /** Weak ancestors found by walking the prerequisite graph, nearest first — never assumes the failure originates at the tested concept (spec §26). */
  weakPrerequisites: Array<{ conceptId: string; conceptName: string; mastery: number; depth: number }>;
}

export interface ClassifiedMistake {
  questionId: string;
  conceptId: string;
  category: ExamMistakeCategoryValue;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  description: string;
  prerequisiteDiagnosis: PrerequisiteDiagnosis | null;
}
