import { z } from "zod";

/**
 * The adaptive engine's public output type. This is a plain data structure
 * — it decides WHAT should happen, never executes anything itself (spec
 * §1). Validated with `NextLearningActionSchema.parse()` right before
 * returning from the engine, so an internal bug can never hand a
 * malformed action to a caller (spec §3) — this engine makes no AI calls,
 * but the same discipline applies to any deterministic output that will
 * drive application logic.
 */
export const ACTION_TYPES = [
  "ACTIVE_RECALL",
  "REMEDIATION",
  "PREREQUISITE_REVIEW",
  "REVIEW",
  "CHALLENGE",
  "REST",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const REASON_TYPES = [
  "PREREQUISITE_GAP",
  "RECENT_MISTAKE",
  "MISCONCEPTION",
  "REPEATED_FAILURE",
  "FORGETTING_RISK",
  "WEAKNESS",
  "GOAL_RELEVANCE",
  "SUCCESS_STREAK",
  "NO_DATA",
  "GENERAL",
] as const;
export type ReasonType = (typeof REASON_TYPES)[number];

export const QUESTION_TYPES = ["RECALL", "EXPLAIN", "COMPARE", "APPLY", "TRANSFER"] as const;
export type ActionQuestionType = (typeof QUESTION_TYPES)[number];

export const ReasonSchema = z.object({
  type: z.enum(REASON_TYPES),
  /** Concise, user-facing text only — never internal prompts, chain-of-thought, or raw scores (spec §27). */
  message: z.string().min(1).max(300),
});
export type Reason = z.infer<typeof ReasonSchema>;

export const NextLearningActionSchema = z.object({
  actionType: z.enum(ACTION_TYPES),
  conceptId: z.string().min(1),
  conceptName: z.string().min(1),
  priority: z.number().min(0).max(1),
  difficulty: z.number().int().min(1).max(5),
  suggestedQuestionType: z.enum(QUESTION_TYPES),
  reason: ReasonSchema,
  /** Short bullet factors for the "Why this?" breakdown (spec §29) — concise, no internals. */
  factors: z.array(z.string().min(1).max(200)).max(8),
  estimatedDurationMinutes: z.number().int().min(0).max(30),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export type NextLearningAction = z.infer<typeof NextLearningActionSchema>;
