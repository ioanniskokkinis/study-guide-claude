import { env } from "@/lib/env";

/**
 * Explicit timeout ceilings per operation family (Phase 19 §19.7) — mirrors
 * token-budgets.ts's grouping. Before this, an audit found 18 of the app's
 * 19 distinct Claude call sites had no `timeoutMs` at all (only
 * ANSWER_EVALUATION, Phase 17's fix for the "Evaluating..." hang, was
 * bounded), so a hung upstream request could block a route for however long
 * the Anthropic SDK's own default takes to give up — and `withRetry`-wrapped
 * call sites could compound that to ~3x. Every category here has a
 * generous-but-finite ceiling instead, tunable per-env without a code
 * change (same rationale as AI_MAX_TOKENS).
 */
export const AI_TIMEOUT_MS = {
  HINT: env.AI_HINT_TIMEOUT_MS,
  TUTOR: env.AI_TUTOR_TIMEOUT_MS,
  EVALUATION: env.AI_EVALUATION_TIMEOUT_MS,
  EXAM: env.AI_EXAM_TIMEOUT_MS,
  STUDY_ADVISOR: env.AI_STUDY_ADVISOR_TIMEOUT_MS,
  QUESTION_GENERATION: env.AI_QUESTION_GENERATION_TIMEOUT_MS,
  KNOWLEDGE_EXTRACTION: env.AI_KNOWLEDGE_EXTRACTION_TIMEOUT_MS,
} as const;

export type AiTimeoutCategory = keyof typeof AI_TIMEOUT_MS;
