import { z } from "zod";

/**
 * `z.coerce.boolean()` is a classic trap for env vars — `Boolean("false")`
 * is `true`, since any non-empty string is truthy. This treats the raw
 * string literally: only `"true"` (case-insensitive) becomes `true`;
 * anything else (including `"false"`, empty, or unset) becomes `false`.
 */
function booleanEnv(defaultValue: boolean) {
  return z.preprocess((v) => (typeof v === "string" ? v.toLowerCase() === "true" : v), z.boolean()).default(defaultValue);
}

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
  // Phase 17 (Active Recall reliability): bounds the single Claude call
  // evaluateAnswer() makes. No AI call anywhere in the app had an explicit
  // timeout before this — the "Evaluating..." hang was an unbounded
  // extractStructured() call with nothing to cut it off. 20s is generous
  // headroom over a typical structured-JSON grading call's latency while
  // staying far short of "indefinite."
  AI_ACTIVE_RECALL_EVALUATION_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // How many not-yet-served questions an Active Recall session tries to keep
  // ready ahead of the student (Phase 17 §5) — bounded on purpose (§11): a
  // small, replenished buffer, never an unbounded generation burst.
  ACTIVE_RECALL_PREFETCH_COUNT: z.coerce.number().int().nonnegative().default(3),
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
  // Phase 14 (TTS / Voice Tutor) — off by default. With TTS_ENABLED=false,
  // no provider is ever constructed and no TTS request is ever made (see
  // src/lib/tts/tts.ts) — the text Tutor works completely unaffected.
  TTS_ENABLED: booleanEnv(false),
  TTS_PROVIDER: z.enum(["openai"]).default("openai"),
  TTS_MODEL: z.string().default("tts-1"),
  TTS_VOICE: z.string().default("alloy"),
  // Server-side only. Never expose this to the browser (no NEXT_PUBLIC_ prefix) — mirrors ANTHROPIC_API_KEY's own handling.
  TTS_API_KEY: z.string().optional(),
  // Generated audio is stored separately from uploaded course documents (STORAGE_ROOT) — a different root, same StorageProvider implementation.
  AUDIO_STORAGE_ROOT: z.string().default("./storage/audio"),
  // A Tutor message's cleaned speech text longer than this is split at sentence boundaries (spec §13) rather than sent to the provider in one huge request or silently truncated.
  TTS_MAX_CHARACTERS: z.coerce.number().int().positive().default(2000),
  // Phase 15 (Study Advisor): roadmap generation is a planning/reasoning
  // task (prioritization + sequencing over a compact context), the same
  // caliber of call as Tutor evaluation/exam grading — defaults to the
  // stronger tier, same split as every other AI_MODEL_* setting.
  AI_MODEL_STUDY_ADVISOR: z.enum(["fast", "default"]).default("default"),
  // Output budget for one roadmap generation call — a full multi-week plan
  // with per-week reasons and priority explanations needs more room than a
  // single evaluation/hint (see src/lib/ai/token-budgets.ts).
  AI_STUDY_ADVISOR_MAX_TOKENS: z.coerce.number().int().positive().default(2500),
  // Phase 19 §19.7: generalizes the timeout pattern AI_ACTIVE_RECALL_EVALUATION_TIMEOUT_MS
  // established for exactly one call site (ANSWER_EVALUATION) to every other
  // Claude call in the app — before this, an audit found 18 of 19 call sites
  // ran with no application-level bound at all, inheriting only the SDK's own
  // multi-minute default. Grouped by the same output-shape categories as
  // AI_MAX_TOKENS (see src/lib/ai/timeout-budgets.ts for exactly which
  // requestType maps to which timeout).
  AI_HINT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  AI_TUTOR_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  AI_EVALUATION_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  AI_EXAM_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
  AI_STUDY_ADVISOR_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  AI_QUESTION_GENERATION_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // Knowledge-graph extraction calls (concept/relationship/prerequisite
  // extraction, semantic dedup) — these already have their own batch-level
  // retry/fallback (extractStructuredWithRetry), so this exists purely to
  // stop one hung call from stalling an entire rebuild batch, not to change
  // their best-effort failure handling.
  AI_KNOWLEDGE_EXTRACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
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
