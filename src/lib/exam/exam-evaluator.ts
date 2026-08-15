import { env } from "@/lib/env";
import { extractStructured } from "@/lib/ai/claude";
import { withRetry } from "@/lib/ai/retry";
import {
  buildAnswerGradingPrompt,
  buildExamQuestionGenerationPrompt,
  buildOralExaminerPrompt,
  type AnswerGradingContext,
  type ExamQuestionGenerationContext,
  type OralExaminerContext,
} from "./exam-prompts";
import { AnswerGradingSchema, ExamQuestionGenerationSchema, OralExaminerMessageSchema, type AnswerGrading, type ExamQuestionGenerationOutput } from "./types";

/**
 * Every Claude call the exam engine makes. Question generation has no
 * fallback content — a fabricated question would violate grounding (spec
 * §9), so a failure here is a first-class "couldn't generate," handled by
 * exam-generator.ts skipping that slot, exactly like question-generator.ts
 * (Phase 5). Grading and the oral examiner DO have deterministic fallbacks
 * (spec §55's precedent from Phase 7): an exam in progress must always be
 * able to finish even if Claude is unavailable.
 */

export async function generateExamQuestionContent(
  ctx: ExamQuestionGenerationContext,
  userId: string,
): Promise<ExamQuestionGenerationOutput> {
  const { system, prompt, schema } = buildExamQuestionGenerationPrompt(ctx);
  const { data } = await withRetry(() =>
    extractStructured({
      model: env.AI_MODEL_EXAM_GENERATION,
      system,
      prompt,
      schema,
      requestType: "EXAM_QUESTION_GENERATION",
      userId,
    }),
  );
  return ExamQuestionGenerationSchema.parse(data);
}

function fallbackGrading(): AnswerGrading {
  return {
    classification: "PARTIALLY_CORRECT",
    criteria: { correctness: 0.5, completeness: 0.5, reasoning: 0.5, application: 0.5, conceptualUnderstanding: 0.5 },
    missingConcepts: [],
    misconceptions: [],
    severity: null,
    feedback: "We couldn't fully evaluate this answer automatically — it has been flagged for manual review.",
  };
}

/** Grades any non-auto-graded answer (open-ended, short answer, problem solving, scenario, teach-back, oral). Never throws — falls back to a neutral, clearly-flagged grade so exam submission always completes (spec §55). */
export async function gradeExamAnswer(ctx: AnswerGradingContext, userId: string): Promise<AnswerGrading> {
  const { system, prompt, schema } = buildAnswerGradingPrompt(ctx);
  try {
    const { data } = await withRetry(() =>
      extractStructured({
        model: env.AI_MODEL_EXAM_GRADING,
        system,
        prompt,
        schema,
        requestType: "EXAM_ANSWER_GRADING",
        userId,
      }),
    );
    return AnswerGradingSchema.parse(data);
  } catch {
    return fallbackGrading();
  }
}

function fallbackExaminerMessage(conceptName: string): string {
  return `Can you tell me more about ${conceptName}?`;
}

/** Generates the oral examiner's next question/follow-up. Falls back to a generic probe if Claude fails — the exam must be able to continue. */
export async function generateOralExaminerMessage(ctx: OralExaminerContext, userId: string): Promise<string> {
  const { system, prompt, schema } = buildOralExaminerPrompt(ctx);
  try {
    const { data } = await withRetry(() =>
      extractStructured({
        model: env.AI_MODEL_EXAM_GENERATION,
        system,
        prompt,
        schema,
        requestType: "EXAM_ORAL_EXAMINER",
        userId,
      }),
    );
    return OralExaminerMessageSchema.parse(data).message;
  } catch {
    return fallbackExaminerMessage(ctx.conceptName);
  }
}
