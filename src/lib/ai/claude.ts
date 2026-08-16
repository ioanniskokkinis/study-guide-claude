import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type { z } from "zod";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db/prisma";

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not configured. Knowledge extraction requires a real Claude API key.",
    );
  }
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return cachedClient;
}

/**
 * "fast" is the cheaper/quicker model for mechanical extraction (finding
 * named concepts); "default" is the stronger model for the harder reasoning
 * steps (relationship and prerequisite analysis). See spec §26.
 */
export type ExtractionModel = "fast" | "default";

const MODEL_IDS: Record<ExtractionModel, string> = {
  fast: env.ANTHROPIC_MODEL_FAST,
  default: env.ANTHROPIC_MODEL_DEFAULT,
};

/** Resolves a model tier to its configured model id — used by latency logging (Phase 11 §7) to name the actual model, not just the tier. */
export function resolveModelId(tier: ExtractionModel): string {
  return MODEL_IDS[tier];
}

// Approximate list pricing per million tokens, used only for AiUsageLog
// cost estimates — not billing-accurate. Update if the configured models change.
const COST_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  [env.ANTHROPIC_MODEL_FAST]: { input: 1.0, output: 5.0 },
  [env.ANTHROPIC_MODEL_DEFAULT]: { input: 3.0, output: 15.0 },
};

export interface ExtractOptions<T> {
  model: ExtractionModel;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  /** Only meaningful (and only sent) for the "default" model — the "fast" model rejects it. */
  effort?: "low" | "medium" | "high";
  /** Tracked separately in AiUsageLog so extraction steps show up as distinct request types (spec §25). */
  requestType: string;
  userId?: string | null;
}

export interface ExtractResult<T> {
  data: T;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Raised when a streaming Claude call fails after some text has already been
 * emitted to the caller (Phase 11 §3) — distinct from a failure before any
 * output, which callers may still fall back from exactly as the non-streaming
 * path already does. `partialText` is never persisted as a successful
 * response; it exists only so callers can decide what (if anything) to log.
 */
export class MidStreamGenerationError extends Error {
  constructor(
    public readonly partialText: string,
    public readonly cause: unknown,
  ) {
    super("Claude streaming generation failed after partial output.");
  }
}

export interface StreamTextOptions {
  model: ExtractionModel;
  system: string;
  prompt: string;
  maxTokens?: number;
  requestType: string;
  userId?: string | null;
  signal?: AbortSignal;
}

/**
 * Plain-text streaming counterpart to `extractStructured` (Phase 11 §2).
 * Deliberately does not use `output_config.format` — structured-output
 * streaming emits partial-JSON deltas, not the readable incremental text the
 * Tutor UI needs, so this is a genuinely separate (unstructured) call shape,
 * used only by the Tutor's language-generation functions. Usage is logged to
 * AiUsageLog exactly once, when the stream completes successfully, mirroring
 * `extractStructured`'s automatic logging.
 */
export function streamText(options: StreamTextOptions): MessageStream {
  const modelId = MODEL_IDS[options.model];
  const anthropic = getClient();

  const stream = anthropic.messages.stream(
    {
      model: modelId,
      max_tokens: options.maxTokens ?? 1024,
      system: options.system,
      messages: [{ role: "user", content: options.prompt }],
    },
    { signal: options.signal },
  );

  stream.once("finalMessage", (message) => {
    void logAiUsage({
      userId: options.userId ?? null,
      model: modelId,
      inputTokens: message.usage.input_tokens ?? 0,
      outputTokens: message.usage.output_tokens,
      requestType: options.requestType,
    });
  });

  return stream;
}

/**
 * Calls Claude for a single structured-JSON extraction step, validated
 * against `schema` server-side (never trust raw model output — spec §8/§9).
 * Every call is logged to AiUsageLog for cost tracking.
 */
export async function extractStructured<T>(options: ExtractOptions<T>): Promise<ExtractResult<T>> {
  const modelId = MODEL_IDS[options.model];
  const anthropic = getClient();

  const response = await anthropic.messages.parse({
    model: modelId,
    max_tokens: options.maxTokens ?? 4096,
    system: options.system,
    messages: [{ role: "user", content: options.prompt }],
    output_config: {
      format: zodOutputFormat(options.schema),
      ...(options.model === "default" && options.effort ? { effort: options.effort } : {}),
    },
  });

  if (response.parsed_output === null) {
    throw new Error("Claude returned output that did not match the expected schema.");
  }

  const usage = {
    inputTokens: response.usage.input_tokens ?? 0,
    outputTokens: response.usage.output_tokens,
  };

  await logAiUsage({
    userId: options.userId ?? null,
    model: modelId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    requestType: options.requestType,
  });

  return { data: response.parsed_output as T, usage };
}

async function logAiUsage(params: {
  userId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  requestType: string;
}): Promise<void> {
  const rates = COST_PER_MILLION_TOKENS[params.model];
  const estimatedCostUsd = rates
    ? (params.inputTokens / 1_000_000) * rates.input + (params.outputTokens / 1_000_000) * rates.output
    : 0;

  await prisma.aiUsageLog.create({
    data: {
      userId: params.userId,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      estimatedCostUsd,
      requestType: params.requestType,
    },
  });
}
