import { env } from "@/lib/env";

/**
 * The single source of truth for Claude pricing (Phase 12 §3) — nothing
 * else in the codebase hard-codes a per-token rate. Approximate list
 * pricing per million tokens, used only for AiUsageLog cost *estimates*,
 * not billing-accurate invoicing. Keyed by the actual configured model id
 * (from ANTHROPIC_MODEL_FAST/ANTHROPIC_MODEL_DEFAULT) rather than a fixed
 * literal, so swapping either env var automatically picks up the right
 * rate — update this table if the configured model ids change price tier.
 */
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  [env.ANTHROPIC_MODEL_FAST]: { input: 1.0, output: 5.0 },
  [env.ANTHROPIC_MODEL_DEFAULT]: { input: 3.0, output: 15.0 },
};

export interface AiCostInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiCostResult {
  estimatedInputCost: number;
  estimatedOutputCost: number;
  estimatedTotalCost: number;
}

/**
 * Computes an estimated USD cost for one Claude call. Returns all-zero
 * costs (rather than throwing) for a model id not in the pricing table —
 * cost estimation must never be the reason a real AI call or its usage
 * logging fails.
 */
export function calculateAiCost({ model, inputTokens, outputTokens }: AiCostInput): AiCostResult {
  const rates = PRICING_PER_MILLION_TOKENS[model];
  if (!rates) {
    return { estimatedInputCost: 0, estimatedOutputCost: 0, estimatedTotalCost: 0 };
  }
  const estimatedInputCost = (inputTokens / 1_000_000) * rates.input;
  const estimatedOutputCost = (outputTokens / 1_000_000) * rates.output;
  return {
    estimatedInputCost,
    estimatedOutputCost,
    estimatedTotalCost: estimatedInputCost + estimatedOutputCost,
  };
}
