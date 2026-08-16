import { extractStructured, type ExtractOptions, type ExtractResult } from "./claude";

export interface StructuredRetryResult<T> extends ExtractResult<T> {
  /** How many Claude calls it took (1-3) — purely for logging/telemetry, never surfaced to the student. */
  attempts: number;
}

/**
 * Raised only after every retry has been exhausted — callers decide how to
 * degrade (skip a best-effort step, mark a pipeline stage failed, show a
 * Retry button), never how to fabricate a result. `cause` is the last
 * underlying error (JSON-parse failure or schema-validation failure).
 */
export class StructuredExtractionFailedError extends Error {
  constructor(
    public readonly cause: unknown,
    public readonly attempts: number,
  ) {
    super("Claude did not return valid structured output after retrying.");
  }
}

function withConstraint<T>(options: ExtractOptions<T>): ExtractOptions<T> {
  return {
    ...options,
    system: `${options.system}\n\nIMPORTANT: Your previous response was invalid or was truncated before it finished. Respond with STRICTLY valid, complete JSON only, matching the schema exactly — no partial output, no trailing commentary.`,
  };
}

/**
 * Bounded, safe retry wrapper around `extractStructured` (spec: "structured
 * output safety" — every AI call must survive a truncated/invalid response
 * without crashing the caller). Never attempts unsafe JSON repair.
 *
 * 1. As requested.
 * 2. Identical request, plus an explicit "your last response was invalid/
 *    truncated, respond with complete valid JSON only" instruction —
 *    transient truncation often doesn't repeat once the model is told.
 * 3. If the caller supplies `shrink` (e.g. half the batch), one more
 *    attempt with a smaller request — a giant response is far more likely
 *    to get cut off by the token budget than a small one.
 *
 * Deliberately does not layer in the existing exponential-backoff
 * `withRetry` — that targets a different failure mode (transient network/
 * rate-limit errors on an otherwise-fine request) and call sites that need
 * both compose them explicitly rather than this always paying the backoff
 * delay on every content-validity retry.
 *
 * Throws StructuredExtractionFailedError only once every tier has failed;
 * the caller is always the one who decides what "failed" means for its own
 * pipeline stage.
 */
export async function extractStructuredWithRetry<T>(
  options: ExtractOptions<T>,
  shrink?: (options: ExtractOptions<T>) => ExtractOptions<T> | null,
): Promise<StructuredRetryResult<T>> {
  let lastError: unknown;

  try {
    const result = await extractStructured(options);
    return { ...result, attempts: 1 };
  } catch (error) {
    lastError = error;
  }

  try {
    const result = await extractStructured(withConstraint(options));
    return { ...result, attempts: 2 };
  } catch (error) {
    lastError = error;
  }

  const shrunk = shrink?.(options);
  if (shrunk) {
    try {
      const result = await extractStructured(withConstraint(shrunk));
      return { ...result, attempts: 3 };
    } catch (error) {
      lastError = error;
    }
  }

  throw new StructuredExtractionFailedError(lastError, shrunk ? 3 : 2);
}
