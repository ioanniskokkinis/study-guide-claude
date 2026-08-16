import { env } from "@/lib/env";
import type { TTSProvider } from "./provider";
import { OpenAiTtsProvider } from "./providers/openai-tts";

let cachedProvider: TTSProvider | null = null;

/** True only when TTS is both enabled and has a configured API key — checked before any provider call, and before the API route even attempts to read the request body (Phase 14 §3/§26). */
export function isTtsEnabled(): boolean {
  return env.TTS_ENABLED && !!env.TTS_API_KEY;
}

/**
 * Resolves the configured `TTSProvider` (Phase 14 §2). Throws if TTS isn't
 * enabled/configured — callers must check `isTtsEnabled()` first; this
 * function existing at all is not itself a signal that a request should
 * proceed.
 */
export function getTtsProvider(): TTSProvider {
  if (!env.TTS_ENABLED) {
    throw new Error("TTS is disabled (TTS_ENABLED=false).");
  }
  if (!env.TTS_API_KEY) {
    throw new Error("TTS_API_KEY is not configured.");
  }
  if (cachedProvider) return cachedProvider;

  switch (env.TTS_PROVIDER) {
    case "openai":
      cachedProvider = new OpenAiTtsProvider(env.TTS_API_KEY, env.TTS_MODEL);
      return cachedProvider;
    default: {
      const exhaustive: never = env.TTS_PROVIDER;
      throw new Error(`Unknown TTS provider: ${String(exhaustive)}`);
    }
  }
}
