import crypto from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { audioStorage } from "@/lib/storage/audio-storage";
import { env } from "@/lib/env";
import { getTtsProvider, isTtsEnabled } from "./tts";
import { calculateTtsCost } from "./pricing";
import { toSpeechText } from "./text-cleaning";
import { splitForTts } from "./chunking";
import { TTSProviderError } from "./provider";

export class TtsDisabledError extends Error {
  constructor() {
    super("Text-to-speech is not enabled.");
  }
}

export class TutorMessageNotFoundError extends Error {
  constructor() {
    super("Tutor message not found.");
  }
}

export class TutorMessageNotEligibleError extends Error {
  constructor(message = "This message cannot be read aloud.") {
    super(message);
  }
}

export interface SynthesizeTutorMessageResult {
  audio: Buffer;
  format: string;
  cacheHit: boolean;
  part: number;
  totalParts: number;
}

/**
 * Synthesizes speech for one persisted Tutor message (Phase 14 §4-6,
 * §9, §12-13). Only ever called on demand, well after the message text
 * has already streamed and persisted (Phase 11/13) — never in the
 * generation path, so it can never add latency to the Tutor's text
 * response (spec §6/§14).
 *
 * Authorization is derived entirely from the message record itself
 * (`session.userId`) — the caller never supplies a session id to check
 * against, which removes a whole class of "does this session id actually
 * match this message" bug rather than merely validating it (spec §4/§23).
 */
export async function synthesizeTutorMessage(params: { messageId: string; userId: string; part?: number }): Promise<SynthesizeTutorMessageResult> {
  if (!isTtsEnabled()) throw new TtsDisabledError();

  const message = await prisma.tutorMessage.findFirst({
    where: { id: params.messageId, role: "TUTOR", session: { userId: params.userId } },
    select: { id: true, sessionId: true, content: true },
  });
  if (!message) throw new TutorMessageNotFoundError();

  // Only the message's own visible content ever reaches TTS (spec §5) — never TutorMessage.metadata
  // (decision action, hint level, classification), which is exactly the "internal reasoning" spec §5 excludes.
  const speechText = toSpeechText(message.content);
  if (speechText.length === 0) throw new TutorMessageNotEligibleError("This message has no speakable text.");

  const parts = splitForTts(speechText, env.TTS_MAX_CHARACTERS);
  const partIndex = Math.min(Math.max(params.part ?? 0, 0), parts.length - 1);
  const partText = parts[partIndex];

  const voice = env.TTS_VOICE;
  const model = env.TTS_MODEL;
  const textHash = crypto.createHash("sha256").update(`${partIndex}:${partText}`).digest("hex");

  const startedAt = Date.now();

  const cached = await prisma.tutorMessageAudio.findUnique({
    where: { messageId_voice_model_textHash: { messageId: message.id, voice, model, textHash } },
  });

  if (cached) {
    try {
      const audio = await audioStorage.read(cached.storageKey);
      await logTtsUsage({
        userId: params.userId,
        sessionId: message.sessionId,
        messageId: message.id,
        provider: cached.provider,
        model,
        voice,
        characterCount: cached.characterCount,
        latencyMs: Date.now() - startedAt,
        cacheHit: true,
        success: true,
      });
      return { audio, format: cached.format, cacheHit: true, part: partIndex, totalParts: parts.length };
    } catch {
      // The cache row exists but the audio file is unreadable (e.g. deleted from disk out of band) —
      // fall through and regenerate rather than failing the request (spec §9/§19: cache failures never break TTS).
    }
  }

  const provider = getTtsProvider();
  let result: Awaited<ReturnType<typeof provider.generate>>;
  try {
    result = await provider.generate({ text: partText, voice, format: "mp3" });
  } catch (error) {
    console.error("[tts] provider generation failed", { provider: env.TTS_PROVIDER, model, voice, latencyMs: Date.now() - startedAt, message: error instanceof Error ? error.message : String(error) });
    await logTtsUsage({
      userId: params.userId,
      sessionId: message.sessionId,
      messageId: message.id,
      provider: env.TTS_PROVIDER,
      model,
      voice,
      characterCount: partText.length,
      latencyMs: Date.now() - startedAt,
      cacheHit: false,
      success: false,
      errorType: "PROVIDER",
    });
    throw error instanceof TTSProviderError ? error : new TTSProviderError("TTS generation failed.", error);
  }

  const storageKey = `tutor/${message.id}/${voice}-${model}-${partIndex}-${textHash.slice(0, 16)}.${result.format}`;
  try {
    await audioStorage.save(storageKey, result.audio);
    await prisma.tutorMessageAudio.create({
      data: {
        messageId: message.id,
        voice,
        model,
        textHash,
        storageKey,
        format: result.format,
        characterCount: partText.length,
        provider: result.provider,
      },
    });
  } catch (error) {
    // A concurrent identical request may have already written this exact cache row (unique constraint) —
    // the audio we just generated is byte-for-byte equivalent, so there's nothing to reconcile. Any other
    // storage/DB failure here must not stop the already-generated audio from reaching the student
    // (spec §19) — it just won't be cached for next time.
    if (!isUniqueConstraintError(error)) {
      console.error("Failed to persist TTS cache entry:", error);
    }
  }

  await logTtsUsage({
    userId: params.userId,
    sessionId: message.sessionId,
    messageId: message.id,
    provider: result.provider,
    model,
    voice,
    characterCount: partText.length,
    latencyMs: Date.now() - startedAt,
    cacheHit: false,
    success: true,
  });

  return { audio: result.audio, format: result.format, cacheHit: false, part: partIndex, totalParts: parts.length };
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002";
}

/** Never throws — a usage-logging failure must not turn a successful TTS response into a failed one (spec §19). */
async function logTtsUsage(params: {
  userId: string;
  sessionId: string;
  messageId: string;
  provider: string;
  model: string;
  voice: string;
  characterCount: number;
  latencyMs: number;
  cacheHit: boolean;
  success: boolean;
  /** Coarse failure category (Phase 19 §19.14) — same taxonomy as AiUsageLog.errorType. Omit/null on success. */
  errorType?: "PROVIDER" | null;
}): Promise<void> {
  try {
    const estimatedCostUsd = params.cacheHit
      ? 0
      : calculateTtsCost({ provider: params.provider, model: params.model, characterCount: params.characterCount });

    await prisma.ttsUsageLog.create({
      data: {
        userId: params.userId,
        sessionId: params.sessionId,
        messageId: params.messageId,
        provider: params.provider,
        model: params.model,
        voice: params.voice,
        characterCount: params.characterCount,
        estimatedCostUsd,
        latencyMs: params.latencyMs,
        cacheHit: params.cacheHit,
        success: params.success,
        errorType: params.errorType ?? null,
      },
    });
  } catch (error) {
    console.error("Failed to log TTS usage:", error);
  }
}
