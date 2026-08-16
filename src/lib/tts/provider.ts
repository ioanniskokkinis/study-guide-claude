/**
 * Provider abstraction for Text-to-Speech (Phase 14 §2) — the Tutor never
 * talks to a TTS vendor's API directly. Every concrete provider
 * implements this same shape, so swapping vendors later only means adding
 * a new class and a branch in `getTtsProvider()` (src/lib/tts/tts.ts),
 * never touching the Tutor or the API route.
 */

export interface TTSGenerateParams {
  /** Already cleaned for speech (src/lib/tts/text-cleaning.ts) — never raw Markdown. */
  text: string;
  voice: string;
  format: "mp3";
}

export interface TTSGenerateResult {
  audio: Buffer;
  format: string;
  /** The provider's own name, for usage logging — not necessarily identical to the configured `TTS_PROVIDER` value if a provider ever proxies another. */
  provider: string;
}

export interface TTSProvider {
  readonly name: string;
  generate(params: TTSGenerateParams): Promise<TTSGenerateResult>;
}

/** Raised on any provider-side failure (HTTP error, network failure, malformed response) — never lets a raw fetch/parse error leak past the provider boundary. */
export class TTSProviderError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}
