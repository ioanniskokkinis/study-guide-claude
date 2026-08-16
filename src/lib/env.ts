import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL_DEFAULT: z.string().default("claude-sonnet-5"),
  ANTHROPIC_MODEL_FAST: z.string().default("claude-haiku-4-5-20251001"),
  STORAGE_ROOT: z.string().default("./storage/uploads"),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().positive().default(50),
  DOCUMENT_CHUNK_SIZE: z.coerce.number().int().positive().default(1200),
  DOCUMENT_CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(150),
  DEV_USER_EMAIL: z.string().email().default("dev@studycoach.local"),
  // Which model *tier* (see src/lib/ai/claude.ts's "fast"/"default") each
  // Phase 5 AI task uses — keeps task->model mapping configurable without
  // duplicating actual model IDs (those stay in ANTHROPIC_MODEL_FAST/DEFAULT).
  AI_MODEL_QUESTION_GENERATION: z.enum(["fast", "default"]).default("fast"),
  AI_MODEL_ANSWER_EVALUATION: z.enum(["fast", "default"]).default("default"),
  AI_MODEL_HINT_GENERATION: z.enum(["fast", "default"]).default("fast"),
  DEFAULT_RECALL_SESSION_LENGTH: z.coerce.number().int().positive().default(10),
  // Phase 7 (Intelligent Tutor): evaluation needs the stronger model
  // (classifying a free-text response, including misconception detection,
  // is the hard reasoning step); generation (Socratic questions, hints,
  // explanations) uses the cheaper/faster model, same split as Phase 5.
  AI_MODEL_TUTOR_EVALUATION: z.enum(["fast", "default"]).default("default"),
  AI_MODEL_TUTOR_GENERATION: z.enum(["fast", "default"]).default("fast"),
  // Phase 8 (Exam & Assessment Engine): grading (open-ended/scenario/oral
  // rubric scoring) needs the stronger model; question generation uses the
  // cheaper/faster one — same split as Phase 5/7.
  AI_MODEL_EXAM_GENERATION: z.enum(["fast", "default"]).default("fast"),
  AI_MODEL_EXAM_GRADING: z.enum(["fast", "default"]).default("default"),
  // Phase 12 (AI cost & token optimization): explicit, tunable ceilings so no
  // call ever falls back to extractStructured/streamText's own generic
  // default (4096 / 1024) — see src/lib/ai/token-budgets.ts for exactly
  // which requestType maps to which budget and why each default was chosen.
  AI_HINT_MAX_TOKENS: z.coerce.number().int().positive().default(200),
  AI_TUTOR_MAX_TOKENS: z.coerce.number().int().positive().default(500),
  AI_EVALUATION_MAX_TOKENS: z.coerce.number().int().positive().default(1000),
  AI_EXAM_MAX_TOKENS: z.coerce.number().int().positive().default(1600),
  // How many of a Tutor session's most recent messages are sent to Claude
  // verbatim (replaces the old hardcoded CONVERSATION_HISTORY_WINDOW).
  AI_CONTEXT_RECENT_MESSAGES: z.coerce.number().int().positive().default(6),
  // Once a session's total message count exceeds this, everything older
  // than AI_CONTEXT_RECENT_MESSAGES is replaced by a deterministic (non-AI)
  // summary instead of being silently dropped — see src/lib/tutor/context.ts.
  AI_CONTEXT_MAX_MESSAGES: z.coerce.number().int().positive().default(12),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", ")}`,
    );
  }
  return parsed.data;
}

export const env = loadEnv();
