import { describe, expect, it } from "vitest";
import { getTtsProvider, isTtsEnabled } from "@/lib/tts/tts";
import { synthesizeTutorMessage, TtsDisabledError } from "@/lib/tts/tutor-message-tts";

/**
 * Phase 14 §3/§26 — this sandbox's real `.env` sets neither TTS_ENABLED nor
 * TTS_API_KEY, so `env.TTS_ENABLED` defaults to `false`. No mocking here on
 * purpose: this exercises the actual "TTS is safely disableable" behavior a
 * production deployment would see before opting in, not a simulated one.
 */
describe("TTS disabled by default (Phase 14 §3, §26) — real env, no mocking", () => {
  it("isTtsEnabled() is false", () => {
    expect(isTtsEnabled()).toBe(false);
  });

  it("getTtsProvider() throws rather than silently returning a non-functional provider", () => {
    expect(() => getTtsProvider()).toThrow(/disabled/i);
  });

  it("synthesizeTutorMessage() rejects with TtsDisabledError before ever querying the database", async () => {
    await expect(synthesizeTutorMessage({ messageId: "irrelevant-id", userId: "irrelevant-user" })).rejects.toThrow(TtsDisabledError);
  });
});
