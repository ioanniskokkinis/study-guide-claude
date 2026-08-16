import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Values referenced inside the hoisted `vi.mock("@/lib/env", ...)` factory
 * below must themselves be declared via `vi.hoisted` (not a plain `const`)
 * — Vitest moves `vi.mock` calls above ordinary top-level statements, so a
 * plain `const` here would still be in its temporal dead zone when the
 * factory runs (same pattern as tests/ai/pricing-and-usage.test.ts's
 * `mockParse`).
 */
const { TEST_AUDIO_ROOT } = vi.hoisted(() => ({
  TEST_AUDIO_ROOT: `${process.cwd()}/tests/.tmp-tts-audio-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}));

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      TTS_ENABLED: true,
      TTS_API_KEY: "test-tts-api-key",
      TTS_PROVIDER: "openai",
      TTS_MODEL: "tts-1",
      TTS_VOICE: "alloy",
      TTS_MAX_CHARACTERS: 2000,
      AUDIO_STORAGE_ROOT: TEST_AUDIO_ROOT,
    },
  };
});

import { prisma } from "@/lib/db/prisma";
import { TTSProviderError } from "@/lib/tts/provider";
import {
  synthesizeTutorMessage,
  TutorMessageNotEligibleError,
  TutorMessageNotFoundError,
} from "@/lib/tts/tutor-message-tts";

/**
 * Phase 14 §4-6, §9, §12-13, §19, §23 — the full on-demand synthesis
 * pipeline: authorization, eligibility, caching, chunking, provider-failure
 * resilience, and usage logging. `@/lib/env` is mocked (whole file) so TTS
 * reads as enabled/configured; `fetch` is mocked per-test so
 * `OpenAiTtsProvider` never makes a real network call.
 */
describe("synthesizeTutorMessage (Phase 14)", () => {
  let userId: string;
  let otherUserId: string;
  let sessionId: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `tts-user-${suffix}@example.com` } });
    userId = user.id;
    const other = await prisma.user.create({ data: { email: `tts-other-${suffix}@example.com` } });
    otherUserId = other.id;
    const course = await prisma.course.create({ data: { userId, title: `TTS Course ${suffix}` } });
    const concept = await prisma.concept.create({ data: { courseId: course.id, name: "TTS Concept", normalizedName: "tts-concept" } });
    const session = await prisma.tutorSession.create({ data: { userId, courseId: course.id, conceptId: concept.id, mode: "SOCRATIC" } });
    sessionId = session.id;
  });

  afterAll(async () => {
    await prisma.ttsUsageLog.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await fs.rm(TEST_AUDIO_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function createMessage(content: string, role: "TUTOR" | "STUDENT" = "TUTOR") {
    return prisma.tutorMessage.create({ data: { sessionId, role, messageType: "EXPLANATION", content } });
  }

  describe("authorization and eligibility (spec §4, §23)", () => {
    it("rejects a nonexistent message id", async () => {
      await expect(synthesizeTutorMessage({ messageId: "does-not-exist", userId })).rejects.toThrow(TutorMessageNotFoundError);
    });

    it("rejects synthesis for a message belonging to another user's session", async () => {
      const message = await createMessage("Owned by the first user.");
      await expect(synthesizeTutorMessage({ messageId: message.id, userId: otherUserId })).rejects.toThrow(TutorMessageNotFoundError);
    });

    it("rejects a STUDENT-authored message — only TUTOR messages are eligible", async () => {
      const message = await createMessage("My own answer.", "STUDENT");
      await expect(synthesizeTutorMessage({ messageId: message.id, userId })).rejects.toThrow(TutorMessageNotFoundError);
    });

    it("rejects a message with no speakable text after cleaning", async () => {
      const message = await createMessage("   \n\n   ");
      await expect(synthesizeTutorMessage({ messageId: message.id, userId })).rejects.toThrow(TutorMessageNotEligibleError);
    });
  });

  describe("content sent to the provider (spec §5)", () => {
    it("sends only the cleaned message content, never internal metadata", async () => {
      const message = await prisma.tutorMessage.create({
        data: {
          sessionId,
          role: "TUTOR",
          messageType: "FEEDBACK",
          content: "Plain feedback text.",
          metadata: { action: "ASK_FOLLOWUP", hintLevel: 2, internalNote: "should never be spoken" },
        },
      });

      await synthesizeTutorMessage({ messageId: message.id, userId });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.input).toBe("Plain feedback text.");
      expect(body.input).not.toContain("internalNote");
      expect(body.input).not.toContain("ASK_FOLLOWUP");
    });
  });

  describe("caching (spec §9, §19)", () => {
    it("generates on a cache miss, persists a cache row, and logs cacheHit=false usage with a positive estimated cost", async () => {
      const message = await createMessage("Cache miss check.");
      const result = await synthesizeTutorMessage({ messageId: message.id, userId });

      expect(result.cacheHit).toBe(false);
      expect(result.format).toBe("mp3");
      expect(result.audio.length).toBeGreaterThan(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const cacheRow = await prisma.tutorMessageAudio.findFirst({ where: { messageId: message.id } });
      expect(cacheRow).not.toBeNull();

      const usageRow = await prisma.ttsUsageLog.findFirst({ where: { messageId: message.id }, orderBy: { createdAt: "desc" } });
      expect(usageRow?.cacheHit).toBe(false);
      expect(usageRow?.success).toBe(true);
      expect(usageRow?.estimatedCostUsd).toBeGreaterThan(0);
    });

    it("serves cached audio on a second identical request without calling the provider again", async () => {
      const message = await createMessage("Cache hit check.");
      await synthesizeTutorMessage({ messageId: message.id, userId });
      fetchMock.mockClear();

      const result = await synthesizeTutorMessage({ messageId: message.id, userId });

      expect(result.cacheHit).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();

      const usageRow = await prisma.ttsUsageLog.findFirst({ where: { messageId: message.id, cacheHit: true } });
      expect(usageRow).not.toBeNull();
      expect(usageRow?.estimatedCostUsd).toBe(0);
    });

    it("invalidates the cache when the underlying message content changes", async () => {
      const message = await createMessage("Original content here.");
      await synthesizeTutorMessage({ messageId: message.id, userId });
      fetchMock.mockClear();

      await prisma.tutorMessage.update({ where: { id: message.id }, data: { content: "Completely different content now." } });
      const result = await synthesizeTutorMessage({ messageId: message.id, userId });

      expect(result.cacheHit).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("the persistence layer keys the cache by messageId+voice+model+textHash, so a different voice or model never collides", async () => {
      const message = await createMessage("Cache key shape check.");
      const base = { messageId: message.id, textHash: "shared-hash", storageKey: "tutor/x/a.mp3", format: "mp3", characterCount: 10, provider: "openai" };

      await prisma.tutorMessageAudio.create({ data: { ...base, voice: "alloy", model: "tts-1" } });
      await expect(prisma.tutorMessageAudio.create({ data: { ...base, voice: "alloy", model: "tts-1" } })).rejects.toThrow();

      await expect(prisma.tutorMessageAudio.create({ data: { ...base, voice: "verse", model: "tts-1" } })).resolves.toBeDefined();
      await expect(prisma.tutorMessageAudio.create({ data: { ...base, voice: "alloy", model: "tts-1-hd" } })).resolves.toBeDefined();
    });

    it("regenerates when a cache row exists but the underlying audio file is missing, instead of failing the request", async () => {
      const message = await createMessage("Cache resiliency check.");
      await synthesizeTutorMessage({ messageId: message.id, userId });

      const cacheRow = await prisma.tutorMessageAudio.findFirstOrThrow({ where: { messageId: message.id } });
      await fs.rm(`${TEST_AUDIO_ROOT}/${cacheRow.storageKey}`, { force: true });

      fetchMock.mockClear();
      const result = await synthesizeTutorMessage({ messageId: message.id, userId });

      expect(result.audio.length).toBeGreaterThan(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("long-response chunking (spec §13-14)", () => {
    it("splits a very long response into parts and serves each part with consistent totalParts metadata", async () => {
      const longContent = Array.from({ length: 60 }, (_, i) => `This is sentence number ${i + 1} of a long tutor explanation.`).join(" ");
      const message = await createMessage(longContent);

      const part0 = await synthesizeTutorMessage({ messageId: message.id, userId });
      expect(part0.totalParts).toBeGreaterThan(1);
      expect(part0.part).toBe(0);

      fetchMock.mockClear();
      const part1 = await synthesizeTutorMessage({ messageId: message.id, userId, part: 1 });
      expect(part1.part).toBe(1);
      expect(part1.totalParts).toBe(part0.totalParts);

      const outOfRange = await synthesizeTutorMessage({ messageId: message.id, userId, part: 999 });
      expect(outOfRange.part).toBe(part0.totalParts - 1);
    });

    it("a short response is never split — exactly one part", async () => {
      const message = await createMessage("A short Tutor reply.");
      const result = await synthesizeTutorMessage({ messageId: message.id, userId });
      expect(result.totalParts).toBe(1);
      expect(result.part).toBe(0);
    });
  });

  describe("provider failure resilience (spec §19)", () => {
    it("surfaces a provider failure as TTSProviderError, logs a failed usage row, and persists no cache row", async () => {
      const message = await createMessage("Some feedback text.");
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });

      await expect(synthesizeTutorMessage({ messageId: message.id, userId })).rejects.toThrow(TTSProviderError);

      const cacheRow = await prisma.tutorMessageAudio.findFirst({ where: { messageId: message.id } });
      expect(cacheRow).toBeNull();

      const usageRow = await prisma.ttsUsageLog.findFirst({ where: { messageId: message.id, success: false } });
      expect(usageRow).not.toBeNull();
    });
  });
});
