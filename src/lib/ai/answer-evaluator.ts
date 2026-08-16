import { env } from "@/lib/env";
import { AiRequestTimeoutError, extractStructured } from "@/lib/ai/claude";
import { AI_MAX_TOKENS } from "@/lib/ai/token-budgets";
import {
  AnswerEvaluationSchema,
  buildAnswerEvaluationPrompt,
  type MistakeCategorySchema,
  type MistakeSeveritySchema,
} from "@/lib/ai/prompts/answer-evaluation";
import type { z } from "zod";

/** Raised when Claude doesn't respond within AI_ACTIVE_RECALL_EVALUATION_TIMEOUT_MS (Phase 17 §16) — distinct from AnswerEvaluationFailedError so callers can offer "Retry evaluation" with an accurate message instead of a generic failure. */
export class AnswerEvaluationTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super("Evaluation timed out.");
  }
}

export type MistakeCategory = z.infer<typeof MistakeCategorySchema>;
export type MistakeSeverityLevel = z.infer<typeof MistakeSeveritySchema>;

export interface EvaluatedError {
  category: MistakeCategory;
  description: string;
  severity: MistakeSeverityLevel;
}

export interface EvaluatedMisconception {
  description: string;
  severity: MistakeSeverityLevel;
}

export interface AnswerEvaluationInput {
  conceptName: string;
  conceptDescription: string;
  questionPrompt: string;
  questionType: string;
  expectedAnswer: string | null;
  rubric: string[];
  sourceChunks: Array<{ id: string; text: string }>;
  /** Only prerequisites in this list can be matched to a prerequisiteGap — grounds the evaluator against the real graph (spec §14). */
  knownPrerequisites: Array<{ id: string; name: string }>;
  studentAnswer: string;
  /** 0-1 normalized, for context only. */
  studentConfidence: number | null;
  userId?: string | null;
}

export interface AnswerEvaluationResult {
  score: number;
  correctness: "CORRECT" | "PARTIAL" | "INCORRECT";
  /** Phase 4 EvidenceOutcome-compatible mapping of `correctness`, for direct use with recordLearningOutcome. */
  outcome: "SUCCESS" | "PARTIAL" | "FAILURE";
  reasoningQuality: number;
  completeness: number;
  strengths: string[];
  missingPoints: string[];
  errors: EvaluatedError[];
  misconceptions: EvaluatedMisconception[];
  feedback: string;
  correctAnswer: string;
  needsRemediation: boolean;
  /** Resolved concept id, but only if the evaluator named a prerequisite that's actually in `knownPrerequisites` — never trusted otherwise. */
  prerequisiteGapConceptId: string | null;
}

function toOutcome(correctness: "CORRECT" | "PARTIAL" | "INCORRECT"): "SUCCESS" | "PARTIAL" | "FAILURE" {
  if (correctness === "CORRECT") return "SUCCESS";
  if (correctness === "PARTIAL") return "PARTIAL";
  return "FAILURE";
}

/**
 * Calls Claude to evaluate a student's free-text answer (spec §11-15).
 * Never writes to the database and never touches mastery directly (spec
 * §21/§28) — callers pass the structured result to recordLearningOutcome.
 *
 * Deliberately a single, timeout-bounded attempt — no `withRetry` wrapping
 * (Phase 17 §16/§2). This call sits directly in front of a student waiting
 * on "Evaluating your answer..."; composing exponential-backoff retries
 * here would just multiply how long that state can last before the UI ever
 * gets a terminal outcome. Retrying is still supported, but as an explicit,
 * user-triggered "Retry evaluation" action (study-session.ts's
 * evaluateSubmittedAnswer) that re-enters this same bounded call, not an
 * automatic loop hidden inside it.
 */
export async function evaluateAnswer(input: AnswerEvaluationInput): Promise<AnswerEvaluationResult> {
  const { system, prompt } = buildAnswerEvaluationPrompt({
    conceptName: input.conceptName,
    conceptDescription: input.conceptDescription,
    questionPrompt: input.questionPrompt,
    questionType: input.questionType,
    expectedAnswer: input.expectedAnswer,
    rubric: input.rubric,
    sourceChunks: input.sourceChunks,
    knownPrerequisites: input.knownPrerequisites.map((p) => p.name),
    studentAnswer: input.studentAnswer,
    studentConfidence: input.studentConfidence,
  });

  let data: z.infer<typeof AnswerEvaluationSchema>;
  try {
    ({ data } = await extractStructured({
      model: env.AI_MODEL_ANSWER_EVALUATION,
      system,
      prompt,
      schema: AnswerEvaluationSchema,
      maxTokens: AI_MAX_TOKENS.EVALUATION,
      requestType: "ANSWER_EVALUATION",
      userId: input.userId,
      timeoutMs: env.AI_ACTIVE_RECALL_EVALUATION_TIMEOUT_MS,
    }));
  } catch (error) {
    if (error instanceof AiRequestTimeoutError) {
      throw new AnswerEvaluationTimeoutError(error.timeoutMs);
    }
    throw error;
  }

  const prerequisiteMatch = data.prerequisiteGapConceptName
    ? input.knownPrerequisites.find((p) => p.name.toLowerCase() === data.prerequisiteGapConceptName!.toLowerCase())
    : undefined;

  return {
    score: data.score,
    correctness: data.correctness,
    outcome: toOutcome(data.correctness),
    reasoningQuality: data.reasoningQuality,
    completeness: data.completeness,
    strengths: data.strengths,
    missingPoints: data.missingPoints,
    errors: data.errors,
    misconceptions: data.misconceptions,
    feedback: data.feedback,
    correctAnswer: data.correctAnswer,
    needsRemediation: data.needsRemediation,
    prerequisiteGapConceptId: prerequisiteMatch?.id ?? null,
  };
}
