import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type { z } from "zod";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db/prisma";
import { calculateAiCost } from "@/lib/ai/pricing";

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
  /** Optional session/conversation identifier for usage aggregation (Phase 12 §13) — a TutorSession/StudySession/Exam id, never a raw student message. */
  sessionId?: string | null;
  /**
   * Bounds how long this call may take (Phase 17 §16) — without this, a
   * slow/hanging Claude response blocks the caller for as long as the SDK's
   * own default timeout allows, with no application-level escape hatch.
   * Aborts the underlying HTTP request via AbortController and throws
   * AiRequestTimeoutError; usage is still logged (success: false) exactly
   * like any other failed call.
   */
  timeoutMs?: number;
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

/** Raised by `extractStructured` when `timeoutMs` elapses before Claude responds (Phase 17 §16) — distinguishable from a genuine API/validation error so callers can offer "Retry" instead of a generic failure. */
export class AiRequestTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Claude did not respond within ${timeoutMs}ms.`);
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
  /** Optional session/conversation identifier for usage aggregation (Phase 12 §13). */
  sessionId?: string | null;
  /**
   * Bounds how long the stream may run with no data at all (Phase 19 §19.7)
   * — before this, `streamText` had no internal ceiling, only the caller's
   * own `signal` (typically the HTTP request's own AbortSignal, which never
   * fires unless the *client* disconnects). Composed with `signal` via
   * `AbortSignal.any` so neither cancellation path is lost.
   */
  timeoutMs?: number;
}

/**
 * Plain-text streaming counterpart to `extractStructured` (Phase 11 §2).
 * Deliberately does not use `output_config.format` — structured-output
 * streaming emits partial-JSON deltas, not the readable incremental text the
 * Tutor UI needs, so this is a genuinely separate (unstructured) call shape,
 * used only by the Tutor's language-generation functions. Usage is logged to
 * AiUsageLog exactly once — on success when the stream completes, on failure
 * when the SDK emits an "error" event (Phase 12 §2: every request is
 * measurable, including failures, not just successes).
 */
export function streamText(options: StreamTextOptions): MessageStream {
  const modelId = MODEL_IDS[options.model];
  const anthropic = getClient();
  const startedAt = Date.now();

  const signals: AbortSignal[] = [];
  if (options.signal) signals.push(options.signal);
  if (options.timeoutMs != null) signals.push(AbortSignal.timeout(options.timeoutMs));
  const combinedSignal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  const stream = anthropic.messages.stream(
    {
      model: modelId,
      max_tokens: options.maxTokens ?? 1024,
      system: options.system,
      messages: [{ role: "user", content: options.prompt }],
    },
    { signal: combinedSignal },
  );

  stream.once("finalMessage", (message) => {
    void logAiUsage({
      userId: options.userId ?? null,
      sessionId: options.sessionId ?? null,
      model: modelId,
      inputTokens: message.usage.input_tokens ?? 0,
      outputTokens: message.usage.output_tokens,
      requestType: options.requestType,
      latencyMs: Date.now() - startedAt,
      success: true,
    });
  });

  stream.once("error", () => {
    void logAiUsage({
      userId: options.userId ?? null,
      sessionId: options.sessionId ?? null,
      model: modelId,
      inputTokens: 0,
      outputTokens: 0,
      requestType: options.requestType,
      latencyMs: Date.now() - startedAt,
      success: false,
    });
  });

  return stream;
}

/**
 * Calls Claude for a single structured-JSON extraction step, validated
 * against `schema` server-side (never trust raw model output — spec §8/§9).
 * Every call is logged to AiUsageLog for cost tracking, including failures
 * (Phase 12 §2) — a failed call still consumed a request and (usually) some
 * input tokens, and callers need that visible even though most callers also
 * wrap this in their own fallback/retry logic.
 */
export async function extractStructured<T>(options: ExtractOptions<T>): Promise<ExtractResult<T>> {
  const modelId = MODEL_IDS[options.model];
  const anthropic = getClient();
  const startedAt = Date.now();

  const controller = options.timeoutMs != null ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;

  let response: Awaited<ReturnType<typeof anthropic.messages.parse>>;
  try {
    response = await anthropic.messages.parse(
      {
        model: modelId,
        max_tokens: options.maxTokens ?? 4096,
        system: options.system,
        messages: [{ role: "user", content: options.prompt }],
        output_config: {
          format: zodOutputFormat(options.schema),
          ...(options.model === "default" && options.effort ? { effort: options.effort } : {}),
        },
      },
      controller ? { signal: controller.signal } : undefined,
    );
  } catch (error) {
    await logAiUsage({
      userId: options.userId ?? null,
      sessionId: options.sessionId ?? null,
      model: modelId,
      inputTokens: 0,
      outputTokens: 0,
      requestType: options.requestType,
      latencyMs: Date.now() - startedAt,
      success: false,
    });
    if (controller?.signal.aborted) {
      throw new AiRequestTimeoutError(options.timeoutMs!);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (response.parsed_output === null) {
    await logAiUsage({
      userId: options.userId ?? null,
      sessionId: options.sessionId ?? null,
      model: modelId,
      inputTokens: response.usage.input_tokens ?? 0,
      outputTokens: response.usage.output_tokens,
      requestType: options.requestType,
      latencyMs: Date.now() - startedAt,
      success: false,
    });
    throw new Error("Claude returned output that did not match the expected schema.");
  }

  const usage = {
    inputTokens: response.usage.input_tokens ?? 0,
    outputTokens: response.usage.output_tokens,
  };

  await logAiUsage({
    userId: options.userId ?? null,
    sessionId: options.sessionId ?? null,
    model: modelId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    requestType: options.requestType,
    latencyMs: Date.now() - startedAt,
    success: true,
  });

  return { data: response.parsed_output as T, usage };
}

async function logAiUsage(params: {
  userId: string | null;
  sessionId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  requestType: string;
  latencyMs: number;
  success: boolean;
}): Promise<void> {
  const { estimatedTotalCost } = calculateAiCost({
    model: params.model,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
  });

  await prisma.aiUsageLog.create({
    data: {
      userId: params.userId,
      sessionId: params.sessionId,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      estimatedCostUsd: estimatedTotalCost,
      requestType: params.requestType,
      latencyMs: params.latencyMs,
      success: params.success,
    },
  });
}
