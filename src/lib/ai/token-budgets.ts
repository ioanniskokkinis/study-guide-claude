import { env } from "@/lib/env";

/**
 * Explicit output-token ceilings per operation family (Phase 12 §5) — before
 * this, every Claude call fell through to `extractStructured`/`streamText`'s
 * own generic default (4096 / 1024 tokens) regardless of how small the
 * actual expected output was. Grouped by output *shape*, not by feature
 * name, since that's what actually determines how much room a call needs:
 *
 * - HINT: single short message, capped ~400 chars by its own Zod schema
 *   (TUTOR_HINT, HINT_GENERATION, EXAM_ORAL_EXAMINER — all share the same
 *   tiny `{message: string}`-shaped schema).
 * - TUTOR: Tutor generation calls with a bit more room — a Socratic message
 *   (same small schema as HINT, but grouped with its sibling generation
 *   calls) and a four-paragraph explanation (~1350 chars worst-case content
 *   across its four fields, per ExplanationContentSchema's field limits).
 * - EVALUATION: structured classification/grading with several array
 *   fields (TUTOR_RESPONSE_EVALUATION, TUTOR_TEACH_BACK_EVALUATION,
 *   ANSWER_EVALUATION, EXAM_ANSWER_GRADING) — sized generously above the
 *   *typical* case since these schemas' own declared maximums (several
 *   arrays of up to 5-6 items) can theoretically run large, and a
 *   truncated evaluation is a real quality regression, not just a wasted
 *   token.
 * - EXAM: the largest structured schemas — full question generation
 *   (prompt + options/expectedAnswer + rubric + optional scenario) and
 *   Active Recall's equivalent QUESTION_GENERATION, whose Zod schema alone
 *   allows a combined ~4800 characters in the worst case.
 *
 * All four are env-configurable (AI_HINT_MAX_TOKENS etc.) specifically so a
 * truncation problem discovered in production can be fixed by raising a
 * number, not by a code change — see Phase 12 §16 (safety limits).
 */
export const AI_MAX_TOKENS = {
  HINT: env.AI_HINT_MAX_TOKENS,
  TUTOR: env.AI_TUTOR_MAX_TOKENS,
  EVALUATION: env.AI_EVALUATION_MAX_TOKENS,
  EXAM: env.AI_EXAM_MAX_TOKENS,
  // Phase 15: a full multi-week roadmap (summary + per-concept reasons +
  // per-week structure + milestones/risks/recommendations) — the largest
  // structured schema in the app after EXAM, sized accordingly.
  STUDY_ADVISOR: env.AI_STUDY_ADVISOR_MAX_TOKENS,
} as const;

export type AiMaxTokensCategory = keyof typeof AI_MAX_TOKENS;
