import { z } from "zod";

/** Mirrors StudentMistakeCategory (Phase 4) — kept as a local literal list, same convention as the knowledge-extraction prompts, so this file has no Prisma dependency. */
export const MistakeCategorySchema = z.enum([
  "FACTUAL_ERROR",
  "CONCEPTUAL_GAP",
  "MISCONCEPTION",
  "PREREQUISITE_GAP",
  "REASONING_ERROR",
  "INCOMPLETE_ANSWER",
  "APPLICATION_FAILURE",
  "TRANSFER_FAILURE",
  "TERMINOLOGY_CONFUSION",
  "CARELESS_ERROR",
]);

/** Mirrors MistakeSeverity (Phase 4). */
export const MistakeSeveritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export const AnswerCorrectnessSchema = z.enum(["CORRECT", "PARTIAL", "INCORRECT"]);

export const AnswerEvaluationSchema = z.object({
  score: z.number().min(0).max(1),
  correctness: AnswerCorrectnessSchema,
  reasoningQuality: z.number().min(0).max(1),
  completeness: z.number().min(0).max(1),
  strengths: z.array(z.string().min(1).max(300)).max(5),
  missingPoints: z.array(z.string().min(1).max(300)).max(5),
  errors: z
    .array(
      z.object({
        category: MistakeCategorySchema,
        description: z.string().min(1).max(500),
        severity: MistakeSeveritySchema,
      }),
    )
    .max(5),
  misconceptions: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        severity: MistakeSeveritySchema,
      }),
    )
    .max(3),
  feedback: z.string().min(1).max(1200),
  correctAnswer: z.string().min(1).max(1500),
  needsRemediation: z.boolean(),
  /** Must be one of the prerequisite names given in the prompt — validated against the real graph after parsing, never trusted outright (spec §14). */
  prerequisiteGapConceptName: z.string().max(200).optional(),
});

export type AnswerEvaluationOutput = z.infer<typeof AnswerEvaluationSchema>;

const SYSTEM_PROMPT = `You are evaluating a student's free-text answer to an Active Recall question, grounded strictly in the provided course material.

Core distinctions you must make (never collapse to a simple right/wrong):
- correctness is CORRECT, PARTIAL, or INCORRECT — never a boolean. A student can have the correct core idea but an incomplete explanation (PARTIAL), or a correct conclusion reached through flawed reasoning (reflect this in reasoningQuality even if correctness is CORRECT).
- A MISCONCEPTION is a specific, identifiable WRONG belief the answer reveals (e.g. "believes a firewall only checks destination port" when it actually needs to track connection state). Only report a misconception when the answer actually demonstrates an incorrect mental model — do NOT invent one just because the answer is incomplete or vague. An answer that simply lacks information is a CONCEPTUAL_GAP or INCOMPLETE_ANSWER error, not a misconception.
- If the answer's mistakes look like the student is actually missing a PREREQUISITE concept (not this concept itself), name that prerequisite in prerequisiteGapConceptName — but ONLY if it appears, verbatim, in the "Known prerequisites of this concept" list provided below. If no listed prerequisite fits, leave it unset. Never invent a prerequisite relationship that isn't in that list.
- Every error needs a category from the given set and a severity. Reserve CRITICAL for errors that would cause real-world harm or completely invalidate the answer; use LOW for minor imprecision.
- feedback should be a short (2-4 sentence) synthesis preparing the student for their next attempt — not a restatement of strengths/missingPoints/errors, which are already itemized separately. Do not write a long essay.
- correctAnswer should be a concise, source-grounded model answer (paraphrase the material — do not invent facts beyond what's provided).
- Set needsRemediation to true only when the gaps are significant enough that the student should revisit this concept (or a prerequisite) before moving on — not for every imperfect answer.
- Base every judgment only on the question, rubric, source material, and the student's answer given below. Do not use outside knowledge to contradict or extend the provided material.
- Return structured JSON only, matching the provided schema.`;

export interface AnswerEvaluationContext {
  conceptName: string;
  conceptDescription: string;
  questionPrompt: string;
  questionType: string;
  expectedAnswer: string | null;
  rubric: string[];
  sourceChunks: Array<{ id: string; text: string }>;
  knownPrerequisites: string[];
  studentAnswer: string;
  studentConfidence: number | null;
}

export function buildAnswerEvaluationPrompt(ctx: AnswerEvaluationContext) {
  const chunkBlocks = ctx.sourceChunks
    .map((chunk) => `Chunk ${chunk.id}:\n"""\n${chunk.text}\n"""`)
    .join("\n\n");

  const sections: string[] = [
    `Concept: ${ctx.conceptName}`,
    `Concept description: ${ctx.conceptDescription}`,
    `Question (${ctx.questionType}): ${ctx.questionPrompt}`,
  ];

  if (ctx.expectedAnswer) {
    sections.push(`Expected answer (reference, not the only acceptable phrasing): ${ctx.expectedAnswer}`);
  }
  if (ctx.rubric.length > 0) {
    sections.push(`Rubric criteria:\n${ctx.rubric.map((r) => `- ${r}`).join("\n")}`);
  }
  sections.push(`Source material:\n${chunkBlocks}`);

  sections.push(
    `Known prerequisites of this concept: ${ctx.knownPrerequisites.length > 0 ? ctx.knownPrerequisites.join(", ") : "(none recorded)"}`,
  );

  if (ctx.studentConfidence != null) {
    sections.push(`Student's self-reported confidence (0-1, for context only — do not let it override your own judgment of correctness): ${ctx.studentConfidence.toFixed(2)}`);
  }

  sections.push(`Student's answer:\n"""\n${ctx.studentAnswer}\n"""`);

  sections.push("Evaluate the student's answer according to the rules above.");

  return { system: SYSTEM_PROMPT, prompt: sections.join("\n\n") };
}
