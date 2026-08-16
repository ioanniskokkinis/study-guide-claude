/**
 * The single source of truth for TTS pricing (Phase 14 §20) — deliberately
 * separate from src/lib/ai/pricing.ts's Claude token pricing. TTS is
 * billed per character, not per token, and must never be mixed into
 * Claude cost totals (spec §20: "Use a separate operation category").
 */
const PRICING_PER_MILLION_CHARACTERS: Record<string, Record<string, number>> = {
  openai: {
    "tts-1": 15.0,
    "tts-1-hd": 30.0,
  },
};

export interface TtsCostInput {
  provider: string;
  model: string;
  characterCount: number;
}

/** Returns 0 (never throws) for an unrecognized provider/model — cost estimation must never be the reason a TTS request or its usage logging fails. */
export function calculateTtsCost({ provider, model, characterCount }: TtsCostInput): number {
  const rate = PRICING_PER_MILLION_CHARACTERS[provider]?.[model];
  if (!rate) return 0;
  return (characterCount / 1_000_000) * rate;
}
