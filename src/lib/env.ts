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
