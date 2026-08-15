import { z } from "zod";

export const QuestionGenerationTypeSchema = z.enum(["RECALL", "EXPLAIN", "APPLY", "TRANSFER", "COMPARE"]);

/**
 * `canGenerate: false` is a first-class outcome, not an error (spec §6) —
 * the generator must be able to refuse when the source material doesn't
 * support a grounded, course-specific question at the requested
 * concept/type/difficulty, rather than inventing facts to fill the gap.
 */
export const QuestionGenerationSchema = z.object({
  canGenerate: z.boolean(),
  refusalReason: z.string().max(500).optional(),
  prompt: z.string().min(10).max(1000).optional(),
  expectedAnswer: z.string().min(1).max(2000).optional(),
  rubric: z.array(z.string().min(1).max(300)).max(6).optional(),
  /// chunkIds the question and expected answer are actually grounded in — re-verified against the real batch, never trusted outright.
  sourceChunkIds: z.array(z.string().min(1)).max(5).optional(),
});

export type QuestionGenerationOutput = z.infer<typeof QuestionGenerationSchema>;

const TYPE_GUIDANCE: Record<z.infer<typeof QuestionGenerationTypeSchema>, string> = {
  RECALL: "The student must retrieve a specific fact, definition, or step directly from memory. No reasoning required — just accurate recall.",
  EXPLAIN: "The student must explain a mechanism, process, or relationship in their own words — how or why something works, not just what it's called.",
  APPLY: "Present a concrete scenario or situation the student hasn't seen verbatim in the source material, and ask them to apply the concept to reason about it.",
  TRANSFER: "Ask the student to apply the concept in a context meaningfully different from how the source material presented it, testing whether understanding generalizes.",
  COMPARE: "Ask the student to distinguish this concept from a closely related one, identifying what's similar and what's different.",
};

const SYSTEM_PROMPT = `You are a study-question writer creating an Active Recall question strictly grounded in the provided course material.

Hard rules:
- Use ONLY the concept description and source chunks given below. Never invent course-specific facts, numbers, or terminology that aren't actually in the material.
- Every question must be answerable from the provided material alone.
- Cite the chunkId(s) the question and expected answer actually draw from in sourceChunkIds. Do not cite a chunk you didn't use.
- If the provided material does not contain enough information to write a good, grounded question of the requested type and difficulty, set canGenerate to false and give a short refusalReason instead of forcing a weak question.
- The rubric should list 2-5 short, checkable criteria a correct answer would satisfy (used later to evaluate student answers) — not a restatement of the expected answer.
- Do not make the expected answer a copy-paste of the question. Do not write ambiguous questions with multiple reasonable answers unless the rubric explicitly accounts for that.
- Avoid trivial rewordings of any "recently asked" questions listed below — write something meaningfully different.
- Return structured JSON only, matching the provided schema.`;

export interface QuestionGenerationContext {
  courseTitle: string;
  conceptName: string;
  conceptDescription: string;
  sourceChunks: Array<{ id: string; text: string }>;
  type: z.infer<typeof QuestionGenerationTypeSchema>;
  difficulty: number;
  prerequisiteContext?: string[];
  studentMasteryNote?: string;
  recentMistakeNotes?: string[];
  recentPrompts?: string[];
}

export function buildQuestionGenerationPrompt(ctx: QuestionGenerationContext) {
  const chunkBlocks = ctx.sourceChunks
    .map((chunk) => `Chunk ${chunk.id}:\n"""\n${chunk.text}\n"""`)
    .join("\n\n");

  const sections: string[] = [
    `Course: ${ctx.courseTitle}`,
    `Concept: ${ctx.conceptName}`,
    `Concept description: ${ctx.conceptDescription}`,
    `Question type: ${ctx.type} — ${TYPE_GUIDANCE[ctx.type]}`,
    `Target difficulty: ${ctx.difficulty}/5 (1 = very easy, 5 = very difficult)`,
    `Source material:\n${chunkBlocks}`,
  ];

  if (ctx.prerequisiteContext && ctx.prerequisiteContext.length > 0) {
    sections.push(`Known prerequisites of this concept: ${ctx.prerequisiteContext.join(", ")}`);
  }
  if (ctx.studentMasteryNote) {
    sections.push(`Student's current standing on this concept: ${ctx.studentMasteryNote}`);
  }
  if (ctx.recentMistakeNotes && ctx.recentMistakeNotes.length > 0) {
    sections.push(`Student's recent mistakes on this concept:\n${ctx.recentMistakeNotes.map((m) => `- ${m}`).join("\n")}`);
  }
  if (ctx.recentPrompts && ctx.recentPrompts.length > 0) {
    sections.push(`Recently asked questions on this concept (write something different):\n${ctx.recentPrompts.map((p) => `- ${p}`).join("\n")}`);
  }

  sections.push("Write one question of the requested type, difficulty, and grounding requirements above.");

  return { system: SYSTEM_PROMPT, prompt: sections.join("\n\n") };
}
