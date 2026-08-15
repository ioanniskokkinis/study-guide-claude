import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
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
