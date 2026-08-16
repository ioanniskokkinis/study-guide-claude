import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

vi.mock("@/lib/ai/claude", () => ({ extractStructured: vi.fn() }));

import { extractStructured } from "@/lib/ai/claude";
import { extractStructuredWithRetry, StructuredExtractionFailedError } from "@/lib/ai/structured-retry";

const schema = z.object({ value: z.string() });

function baseOptions() {
  return {
    model: "fast" as const,
    system: "system",
    prompt: "prompt",
    schema,
    requestType: "test",
  };
}

/**
 * Production-hardening phase §A6/§N — malformed/truncated Claude JSON,
 * retry after AI failure, bounded attempts.
 */
describe("extractStructuredWithRetry", () => {
  beforeEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  it("returns on the first attempt when it succeeds", async () => {
    vi.mocked(extractStructured).mockResolvedValue({ data: { value: "ok" }, usage: { inputTokens: 1, outputTokens: 1 } });

    const result = await extractStructuredWithRetry(baseOptions());
    expect(result.data.value).toBe("ok");
    expect(result.attempts).toBe(1);
    expect(extractStructured).toHaveBeenCalledTimes(1);
  });

  it("retries once with a constrained prompt after a truncated/invalid JSON failure", async () => {
    vi.mocked(extractStructured)
      .mockRejectedValueOnce(new Error('Failed to parse structured output as JSON: Unterminated string in JSON at position 5074'))
      .mockResolvedValueOnce({ data: { value: "ok" }, usage: { inputTokens: 1, outputTokens: 1 } });

    const result = await extractStructuredWithRetry(baseOptions());
    expect(result.attempts).toBe(2);
    expect(extractStructured).toHaveBeenCalledTimes(2);
    const secondCallSystem = vi.mocked(extractStructured).mock.calls[1][0].system;
    expect(secondCallSystem).toContain("STRICTLY valid, complete JSON");
  });

  it("falls back to a caller-supplied smaller request on a third attempt", async () => {
    vi.mocked(extractStructured)
      .mockRejectedValueOnce(new Error("invalid json"))
      .mockRejectedValueOnce(new Error("invalid json"))
      .mockResolvedValueOnce({ data: { value: "shrunk" }, usage: { inputTokens: 1, outputTokens: 1 } });

    const result = await extractStructuredWithRetry(baseOptions(), (opts) => ({ ...opts, prompt: "smaller prompt" }));
    expect(result.attempts).toBe(3);
    expect(result.data.value).toBe("shrunk");
    const thirdCallPrompt = vi.mocked(extractStructured).mock.calls[2][0].prompt;
    expect(thirdCallPrompt).toBe("smaller prompt");
  });

  it("throws StructuredExtractionFailedError once every attempt (including shrink) is exhausted", async () => {
    vi.mocked(extractStructured).mockRejectedValue(new Error("always invalid"));

    await expect(extractStructuredWithRetry(baseOptions(), (opts) => ({ ...opts, prompt: "smaller" }))).rejects.toBeInstanceOf(
      StructuredExtractionFailedError,
    );
    expect(extractStructured).toHaveBeenCalledTimes(3);
  });

  it("throws after two attempts when no shrink function is supplied", async () => {
    vi.mocked(extractStructured).mockRejectedValue(new Error("always invalid"));

    await expect(extractStructuredWithRetry(baseOptions())).rejects.toBeInstanceOf(StructuredExtractionFailedError);
    expect(extractStructured).toHaveBeenCalledTimes(2);
  });

  it("does not call shrink when the identical retry already succeeds", async () => {
    vi.mocked(extractStructured)
      .mockRejectedValueOnce(new Error("invalid json"))
      .mockResolvedValueOnce({ data: { value: "ok" }, usage: { inputTokens: 1, outputTokens: 1 } });
    const shrink = vi.fn((opts) => ({ ...opts, prompt: "smaller" }));

    await extractStructuredWithRetry(baseOptions(), shrink);
    expect(shrink).not.toHaveBeenCalled();
  });
});
