import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { env } from "@/lib/env";
import { calculateAiCost } from "@/lib/ai/pricing";
import { AI_MAX_TOKENS } from "@/lib/ai/token-budgets";
import {
  getCostByModel,
  getCostByOperation,
  getMostExpensiveOperations,
  getRequestsPerDay,
  getTotalAiCost,
  getUsageSummary,
} from "@/lib/ai/usage-aggregation";
import { prisma } from "@/lib/db/prisma";

/**
 * Mocks the Anthropic SDK's `messages.parse` (not `@/lib/ai/claude` itself)
 * so the "extractStructured usage instrumentation" describe block below can
 * exercise claude.ts's own logging logic for real, instead of testing
 * around it like every other test file in this codebase does. Declared and
 * mocked at module top level (required for Vitest's hoisting to apply)
 * even though it's only used by one describe block further down.
 *
 * This dev sandbox's .env has ANTHROPIC_API_KEY="" (no real key), which
 * `getClient()` would otherwise reject before ever reaching the (mocked)
 * SDK call — so `@/lib/env` is also mocked here, overriding only that one
 * field and passing every other real env value straight through (pricing
 * and token-budget lookups elsewhere in this file must stay accurate).
 */
const { mockParse } = vi.hoisted(() => ({ mockParse: vi.fn() }));
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  // Real RateLimitError/APIError classes are kept (not mocked) so
  // claude.ts's categorizeAiError() can genuinely `instanceof` them
  // (Phase 19 §19.14) — only the client's `messages.parse` call itself is faked.
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class FakeAnthropic {
    messages = { parse: (...args: unknown[]) => mockParse(...args) };
  }
  Object.assign(FakeAnthropic, { RateLimitError: actual.default.RateLimitError, APIError: actual.default.APIError });
  return { ...actual, default: FakeAnthropic };
});
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, env: { ...actual.env, ANTHROPIC_API_KEY: "test-anthropic-api-key" } };
});

import { AiRequestTimeoutError, extractStructured } from "@/lib/ai/claude";

/**
 * Phase 12 §3/§14 — cost calculation and usage aggregation. Real Postgres,
 * no Claude mocking needed here: these functions only read/write
 * AiUsageLog rows, exactly like the dashboard-aggregation tests (Phase 10)
 * only read Phase 4/6/8/9 tables.
 */
describe("calculateAiCost (Phase 12 §3)", () => {
  it("computes input/output/total cost from the centralized pricing table", () => {
    const result = calculateAiCost({ model: env.ANTHROPIC_MODEL_FAST, inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(result.estimatedInputCost).toBeCloseTo(1.0, 5);
    expect(result.estimatedOutputCost).toBeCloseTo(5.0, 5);
    expect(result.estimatedTotalCost).toBeCloseTo(6.0, 5);
  });

  it("scales linearly with token count", () => {
    const result = calculateAiCost({ model: env.ANTHROPIC_MODEL_DEFAULT, inputTokens: 500_000, outputTokens: 0 });
    expect(result.estimatedInputCost).toBeCloseTo(1.5, 5);
    expect(result.estimatedTotalCost).toBeCloseTo(1.5, 5);
  });

  it("returns all-zero cost for an unrecognized model instead of throwing", () => {
    const result = calculateAiCost({ model: "not-a-real-model", inputTokens: 1000, outputTokens: 1000 });
    expect(result).toEqual({ estimatedInputCost: 0, estimatedOutputCost: 0, estimatedTotalCost: 0 });
  });
});

describe("AI_MAX_TOKENS (Phase 12 §5)", () => {
  it("resolves each budget category from its env var rather than a hardcoded literal", () => {
    expect(AI_MAX_TOKENS.HINT).toBe(env.AI_HINT_MAX_TOKENS);
    expect(AI_MAX_TOKENS.TUTOR).toBe(env.AI_TUTOR_MAX_TOKENS);
    expect(AI_MAX_TOKENS.EVALUATION).toBe(env.AI_EVALUATION_MAX_TOKENS);
    expect(AI_MAX_TOKENS.EXAM).toBe(env.AI_EXAM_MAX_TOKENS);
  });

  it("every budget is well below extractStructured's old unbounded default (4096) and streamText's (1024)", () => {
    for (const value of Object.values(AI_MAX_TOKENS)) {
      expect(value).toBeLessThan(4096);
    }
  });
});

describe("model routing (Phase 12 §4) — already-correct routing left unchanged", () => {
  it("evaluation/grading operations use the stronger 'default' tier", () => {
    expect(env.AI_MODEL_TUTOR_EVALUATION).toBe("default");
    expect(env.AI_MODEL_ANSWER_EVALUATION).toBe("default");
    expect(env.AI_MODEL_EXAM_GRADING).toBe("default");
  });

  it("generation operations use the cheaper 'fast' tier", () => {
    expect(env.AI_MODEL_TUTOR_GENERATION).toBe("fast");
    expect(env.AI_MODEL_QUESTION_GENERATION).toBe("fast");
    expect(env.AI_MODEL_HINT_GENERATION).toBe("fast");
    expect(env.AI_MODEL_EXAM_GENERATION).toBe("fast");
  });
});

describe("usage aggregation (Phase 12 §14)", () => {
  let userId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-usage-${suffix}@example.com` } });
    userId = user.id;

    await prisma.aiUsageLog.createMany({
      data: [
        {
          userId,
          sessionId: "session-a",
          model: "claude-fast-mock",
          requestType: "TUTOR_HINT",
          inputTokens: 100,
          outputTokens: 50,
          estimatedCostUsd: 0.001,
          latencyMs: 500,
          success: true,
        },
        {
          userId,
          sessionId: "session-a",
          model: "claude-fast-mock",
          requestType: "TUTOR_HINT",
          inputTokens: 120,
          outputTokens: 60,
          estimatedCostUsd: 0.0012,
          latencyMs: 400,
          success: true,
        },
        {
          userId,
          sessionId: "session-b",
          model: "claude-default-mock",
          requestType: "TUTOR_RESPONSE_EVALUATION",
          inputTokens: 800,
          outputTokens: 200,
          estimatedCostUsd: 0.02,
          latencyMs: 900,
          success: true,
        },
        {
          userId,
          sessionId: "session-b",
          model: "claude-default-mock",
          requestType: "TUTOR_RESPONSE_EVALUATION",
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          latencyMs: 1200,
          success: false,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.aiUsageLog.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("getTotalAiCost sums estimatedCostUsd across matching rows", async () => {
    const total = await getTotalAiCost({ userId });
    expect(total).toBeCloseTo(0.001 + 0.0012 + 0.02 + 0, 6);
  });

  it("getCostByModel groups totals and request counts per model", async () => {
    const byModel = await getCostByModel({ userId });
    const fast = byModel.find((m) => m.model === "claude-fast-mock");
    const strong = byModel.find((m) => m.model === "claude-default-mock");
    expect(fast?.requestCount).toBe(2);
    expect(strong?.requestCount).toBe(2);
    expect(fast?.totalCostUsd).toBeCloseTo(0.0022, 6);
  });

  it("getCostByOperation groups by requestType and computes per-request averages", async () => {
    const byOp = await getCostByOperation({ userId });
    const hint = byOp.find((o) => o.operation === "TUTOR_HINT");
    expect(hint?.requestCount).toBe(2);
    expect(hint?.averageCostUsd).toBeCloseTo((0.001 + 0.0012) / 2, 6);
    expect(hint?.averageTokensPerRequest).toBeCloseTo((100 + 50 + 120 + 60) / 2, 6);
  });

  it("getMostExpensiveOperations sorts by total cost descending and respects the limit", async () => {
    const top = await getMostExpensiveOperations(1, { userId });
    expect(top).toHaveLength(1);
    expect(top[0].operation).toBe("TUTOR_RESPONSE_EVALUATION");
  });

  it("getUsageSummary reports success/failure counts and averages", async () => {
    const summary = await getUsageSummary({ userId });
    expect(summary.totalRequests).toBe(4);
    expect(summary.successfulRequests).toBe(3);
    expect(summary.failedRequests).toBe(1);
    expect(summary.averageCostPerRequest).toBeCloseTo((0.001 + 0.0012 + 0.02 + 0) / 4, 6);
  });

  it("getRequestsPerDay buckets rows by calendar day", async () => {
    const perDay = await getRequestsPerDay({ userId });
    const totalRequests = perDay.reduce((sum, d) => sum + d.requestCount, 0);
    expect(totalRequests).toBe(4);
  });
});

describe("extractStructured usage instrumentation (Phase 12 §2)", () => {
  let userId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-extract-${suffix}@example.com` } });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.aiUsageLog.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  afterEach(() => {
    mockParse.mockReset();
  });

  it("logs a successful call with tokens, cost, sessionId, latency, and success=true", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { message: "ok" },
      usage: { input_tokens: 42, output_tokens: 7 },
    });

    await extractStructured({
      model: "fast",
      system: "sys",
      prompt: "prompt",
      schema: z.object({ message: z.string() }),
      requestType: "TEST_OPERATION",
      userId,
      sessionId: "session-xyz",
    });

    const row = await prisma.aiUsageLog.findFirst({ where: { userId, requestType: "TEST_OPERATION" }, orderBy: { createdAt: "desc" } });
    expect(row).not.toBeNull();
    expect(row?.inputTokens).toBe(42);
    expect(row?.outputTokens).toBe(7);
    expect(row?.sessionId).toBe("session-xyz");
    expect(row?.success).toBe(true);
    expect(row?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(row?.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("logs a failed call (thrown API error) with success=false and zero tokens, then still rethrows", async () => {
    mockParse.mockRejectedValue(new Error("simulated API failure"));

    await expect(
      extractStructured({
        model: "fast",
        system: "sys",
        prompt: "prompt",
        schema: z.object({ message: z.string() }),
        requestType: "TEST_OPERATION_FAILURE",
        userId,
        sessionId: "session-xyz",
      }),
    ).rejects.toThrow("simulated API failure");

    const row = await prisma.aiUsageLog.findFirst({ where: { userId, requestType: "TEST_OPERATION_FAILURE" }, orderBy: { createdAt: "desc" } });
    expect(row).not.toBeNull();
    expect(row?.success).toBe(false);
    expect(row?.inputTokens).toBe(0);
    expect(row?.outputTokens).toBe(0);
    expect(row?.errorType).toBe("UNKNOWN");
  });

  /** Phase 19 §19.14 — a rate-limit failure must be distinguishable from any other provider error in AiUsageLog, without a second telemetry system. */
  it("categorizes a RateLimitError from the SDK as errorType RATE_LIMIT", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    mockParse.mockRejectedValue(new Anthropic.RateLimitError(429, {}, "Rate limited", new Headers()));

    await expect(
      extractStructured({
        model: "fast",
        system: "sys",
        prompt: "prompt",
        schema: z.object({ message: z.string() }),
        requestType: "TEST_RATE_LIMIT",
        userId,
      }),
    ).rejects.toThrow();

    const row = await prisma.aiUsageLog.findFirst({ where: { userId, requestType: "TEST_RATE_LIMIT" }, orderBy: { createdAt: "desc" } });
    expect(row?.success).toBe(false);
    expect(row?.errorType).toBe("RATE_LIMIT");
  });

  it("logs a successful call with errorType null", async () => {
    mockParse.mockResolvedValue({ parsed_output: { message: "ok" }, usage: { input_tokens: 1, output_tokens: 1 } });
    await extractStructured({
      model: "fast",
      system: "sys",
      prompt: "prompt",
      schema: z.object({ message: z.string() }),
      requestType: "TEST_SUCCESS_ERROR_TYPE",
      userId,
    });
    const row = await prisma.aiUsageLog.findFirst({ where: { userId, requestType: "TEST_SUCCESS_ERROR_TYPE" }, orderBy: { createdAt: "desc" } });
    expect(row?.errorType).toBeNull();
  });

  it("logs a schema-mismatch (parsed_output null) as a failure while still recording input tokens", async () => {
    mockParse.mockResolvedValue({
      parsed_output: null,
      usage: { input_tokens: 15, output_tokens: 3 },
    });

    await expect(
      extractStructured({
        model: "fast",
        system: "sys",
        prompt: "prompt",
        schema: z.object({ message: z.string() }),
        requestType: "TEST_OPERATION_SCHEMA_MISMATCH",
        userId,
      }),
    ).rejects.toThrow("did not match the expected schema");

    const row = await prisma.aiUsageLog.findFirst({
      where: { userId, requestType: "TEST_OPERATION_SCHEMA_MISMATCH" },
      orderBy: { createdAt: "desc" },
    });
    expect(row).not.toBeNull();
    expect(row?.success).toBe(false);
    expect(row?.inputTokens).toBe(15);
    expect(row?.errorType).toBe("VALIDATION");
  });

  /** Phase 17 §16 — the root cause of the "Evaluating..." hang was that no AI call anywhere had a bounded timeout. This exercises the actual AbortController wiring, not just a mocked rejection. */
  it("aborts via AbortSignal once timeoutMs elapses, throws AiRequestTimeoutError, and still logs the failed call", async () => {
    mockParse.mockImplementation((_params: unknown, options?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          const err = new Error("Request was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    await expect(
      extractStructured({
        model: "fast",
        system: "sys",
        prompt: "prompt",
        schema: z.object({ message: z.string() }),
        requestType: "TEST_TIMEOUT",
        userId,
        timeoutMs: 20,
      }),
    ).rejects.toBeInstanceOf(AiRequestTimeoutError);

    const row = await prisma.aiUsageLog.findFirst({ where: { userId, requestType: "TEST_TIMEOUT" }, orderBy: { createdAt: "desc" } });
    expect(row).not.toBeNull();
    expect(row?.success).toBe(false);
    expect(row?.inputTokens).toBe(0);
    expect(row?.errorType).toBe("TIMEOUT");
  });

  it("a call that resolves well within timeoutMs is unaffected by it", async () => {
    mockParse.mockResolvedValue({ parsed_output: { message: "fast enough" }, usage: { input_tokens: 5, output_tokens: 2 } });

    const result = await extractStructured({
      model: "fast",
      system: "sys",
      prompt: "prompt",
      schema: z.object({ message: z.string() }),
      requestType: "TEST_TIMEOUT_NOT_HIT",
      userId,
      timeoutMs: 20_000,
    });
    expect(result.data.message).toBe("fast enough");
  });
});
