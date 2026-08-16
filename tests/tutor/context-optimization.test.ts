import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/claude")>("@/lib/ai/claude");
  return {
    extractStructured: vi.fn(),
    streamText: vi.fn(),
    MidStreamGenerationError: actual.MidStreamGenerationError,
    resolveModelId: vi.fn(() => "claude-mock-model"),
  };
});

import { extractStructured, streamText } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { buildConversationSummary } from "@/lib/tutor/context";
import { CONVERSATION_HISTORY_WINDOW } from "@/lib/tutor/config";
import { getTutorContext } from "@/lib/tutor/tutor-state";
import { startTutorSession, streamTutorMessage } from "@/lib/tutor/tutor-orchestrator";

interface MockCallOptions {
  requestType: string;
}

function fakeTextStream(chunks: string[]) {
  async function* gen() {
    for (const chunk of chunks) {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: chunk } };
    }
  }
  return gen();
}

let nextEvaluation: Record<string, unknown> = {};

function resetMocks() {
  nextEvaluation = {
    classification: "CORRECT",
    confidence: 0.8,
    misconceptionDescription: null,
    severity: null,
    missingConcepts: [],
    recommendedAction: "ASK_FOLLOWUP",
    feedback: "Good.",
  };

  vi.mocked(extractStructured).mockImplementation(async (options: unknown) => {
    const { requestType } = options as MockCallOptions;
    const usage = { inputTokens: 1, outputTokens: 1 };
    if (requestType === "TUTOR_RESPONSE_EVALUATION") return { data: nextEvaluation, usage };
    if (requestType === "TUTOR_SOCRATIC_MESSAGE") return { data: { message: "Mock opening question?" }, usage };
    throw new Error(`unmocked requestType ${requestType}`);
  });

  vi.mocked(streamText).mockImplementation(() => fakeTextStream(["Mock reply."]) as never);
}

describe("conversation window + summary (Phase 12 §6-9)", () => {
  it("CONVERSATION_HISTORY_WINDOW is sourced from AI_CONTEXT_RECENT_MESSAGES, not a hardcoded literal", () => {
    expect(CONVERSATION_HISTORY_WINDOW).toBe(env.AI_CONTEXT_RECENT_MESSAGES);
  });

  describe("buildConversationSummary", () => {
    let userId: string;
    let courseId: string;
    let sessionId: string;

    beforeAll(async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const user = await prisma.user.create({ data: { email: `test-context-${suffix}@example.com` } });
      userId = user.id;
      const course = await prisma.course.create({ data: { userId, title: `Context ${suffix}` } });
      courseId = course.id;
      const concept = await prisma.concept.create({ data: { courseId, name: "Summary Concept", normalizedName: "summary-concept" } });
      const session = await prisma.tutorSession.create({ data: { userId, courseId, conceptId: concept.id, mode: "SOCRATIC" } });
      sessionId = session.id;
    });

    afterAll(async () => {
      await prisma.user.deleteMany({ where: { id: userId } });
    });

    it("returns null for a short session that fits entirely within the recent window", async () => {
      for (let i = 0; i < 3; i++) {
        await prisma.tutorMessage.create({
          data: { sessionId, role: i % 2 === 0 ? "TUTOR" : "STUDENT", content: `turn ${i}`, messageType: "QUESTION" },
        });
      }
      const summary = await buildConversationSummary(sessionId, CONVERSATION_HISTORY_WINDOW);
      expect(summary).toBeNull();
    });

    it("returns a deterministic tally once the session exceeds AI_CONTEXT_MAX_MESSAGES, covering only the turns older than the recent window", async () => {
      // Already has 3 messages from the previous test; add enough to clear AI_CONTEXT_MAX_MESSAGES.
      const additional = env.AI_CONTEXT_MAX_MESSAGES + 5;
      for (let i = 0; i < additional; i++) {
        await prisma.tutorMessage.create({
          data: { sessionId, role: "TUTOR", content: `later turn ${i}`, messageType: "HINT" },
        });
      }
      const summary = await buildConversationSummary(sessionId, CONVERSATION_HISTORY_WINDOW);
      expect(summary).not.toBeNull();
      expect(summary).toContain("Earlier in this session");
      expect(summary).toMatch(/hint given/);
    });
  });

  describe("getTutorContext includes the summary and keeps conversationHistory bounded", () => {
    let userId: string;
    let courseId: string;
    let conceptId: string;
    let sessionId: string;

    beforeAll(async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const user = await prisma.user.create({ data: { email: `test-context-full-${suffix}@example.com` } });
      userId = user.id;
      const course = await prisma.course.create({ data: { userId, title: `Context Full ${suffix}` } });
      courseId = course.id;
      const concept = await prisma.concept.create({ data: { courseId, name: "Full Concept", normalizedName: "full-concept" } });
      conceptId = concept.id;
      const session = await prisma.tutorSession.create({ data: { userId, courseId, conceptId, mode: "SOCRATIC" } });
      sessionId = session.id;

      const totalTurns = env.AI_CONTEXT_MAX_MESSAGES + 8;
      for (let i = 0; i < totalTurns; i++) {
        await prisma.tutorMessage.create({
          data: { sessionId, role: i % 2 === 0 ? "TUTOR" : "STUDENT", content: `turn ${i}`, messageType: "FEEDBACK" },
        });
      }
    });

    afterAll(async () => {
      await prisma.user.deleteMany({ where: { id: userId } });
    });

    it("caps conversationHistory at AI_CONTEXT_RECENT_MESSAGES and provides a non-null summary for the rest", async () => {
      const ctx = await getTutorContext({ userId, courseId, conceptId, sessionId, mode: "SOCRATIC" });
      expect(ctx).not.toBeNull();
      expect(ctx!.conversationHistory).toHaveLength(env.AI_CONTEXT_RECENT_MESSAGES);
      expect(ctx!.conversationSummary).not.toBeNull();
    });
  });
});

describe("duplicate-submission protection (Phase 12 §11-12)", () => {
  let userId: string;
  let courseId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-dedup-${suffix}@example.com` } });
    userId = user.id;
    const course = await prisma.course.create({ data: { userId, title: `Dedup ${suffix}` } });
    courseId = course.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  beforeEach(() => {
    vi.mocked(extractStructured).mockReset();
    vi.mocked(streamText).mockReset();
    resetMocks();
  });

  it("an identical (session, content) turn submitted twice within the dedup window makes only one Claude generation call and persists only one TutorMessage", async () => {
    const concept = await prisma.concept.create({ data: { courseId, name: "Dedup Concept", normalizedName: "dedup-concept" } });
    const { session } = await startTutorSession({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });

    async function drain(content: string) {
      const events = [];
      for await (const event of streamTutorMessage({ sessionId: session.id, userId, content })) events.push(event);
      return events;
    }

    const first = await drain("Duplicate answer text.");
    const streamCallsAfterFirst = vi.mocked(streamText).mock.calls.length;
    const second = await drain("Duplicate answer text.");
    const streamCallsAfterSecond = vi.mocked(streamText).mock.calls.length;

    expect(streamCallsAfterSecond).toBe(streamCallsAfterFirst); // no new Claude call for the replayed duplicate
    const firstComplete = first.find((e) => e.type === "complete");
    const secondComplete = second.find((e) => e.type === "complete");
    expect(firstComplete).toBeDefined();
    expect(secondComplete).toBeDefined();
    if (firstComplete?.type === "complete" && secondComplete?.type === "complete") {
      expect(secondComplete.message.id).toBe(firstComplete.message.id);
    }

    // startTutorSession() itself persists one opening TUTOR message (the opening question) before either drain() call —
    // so a correctly-deduped second submission means exactly 2 TUTOR messages total (opening + the one real reply),
    // never 3, and exactly 1 STUDENT message (the replayed duplicate must not create a second one).
    const tutorMessageCount = await prisma.tutorMessage.count({ where: { sessionId: session.id, role: "TUTOR" } });
    expect(tutorMessageCount).toBe(2);
    const studentMessageCount = await prisma.tutorMessage.count({ where: { sessionId: session.id, role: "STUDENT" } });
    expect(studentMessageCount).toBe(1);
  });

  it("a different session with the same content text is not treated as a duplicate", async () => {
    const conceptA = await prisma.concept.create({ data: { courseId, name: "Dedup A", normalizedName: "dedup-a" } });
    const conceptB = await prisma.concept.create({ data: { courseId, name: "Dedup B", normalizedName: "dedup-b" } });
    const { session: sessionA } = await startTutorSession({ userId, courseId, conceptId: conceptA.id, mode: "SOCRATIC" });
    const { session: sessionB } = await startTutorSession({ userId, courseId, conceptId: conceptB.id, mode: "SOCRATIC" });

    async function drain(sessionId: string, content: string) {
      const events = [];
      for await (const event of streamTutorMessage({ sessionId, userId, content })) events.push(event);
      return events;
    }

    await drain(sessionA.id, "Same text, different session.");
    const callsAfterA = vi.mocked(streamText).mock.calls.length;
    await drain(sessionB.id, "Same text, different session.");
    const callsAfterB = vi.mocked(streamText).mock.calls.length;

    expect(callsAfterB).toBeGreaterThan(callsAfterA); // a genuinely new session must not be short-circuited by the cache
  });
});

describe("deterministic shortcuts skip Claude entirely (Phase 12 §10)", () => {
  let userId: string;
  let courseId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-shortcuts-${suffix}@example.com` } });
    userId = user.id;
    const course = await prisma.course.create({ data: { userId, title: `Shortcuts ${suffix}` } });
    courseId = course.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  beforeEach(() => {
    vi.mocked(extractStructured).mockReset();
    vi.mocked(streamText).mockReset();
    resetMocks();
  });

  it("an explicit 'I don't know' never calls the evaluation model", async () => {
    const concept = await prisma.concept.create({ data: { courseId, name: "Shortcut Concept", normalizedName: "shortcut-concept" } });
    const { session } = await startTutorSession({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });

    const evaluationCallsBefore = vi.mocked(extractStructured).mock.calls.filter(
      (c) => (c[0] as MockCallOptions).requestType === "TUTOR_RESPONSE_EVALUATION",
    ).length;

    const events = [];
    for await (const event of streamTutorMessage({ sessionId: session.id, userId, content: "I don't know" })) events.push(event);

    const evaluationCallsAfter = vi.mocked(extractStructured).mock.calls.filter(
      (c) => (c[0] as MockCallOptions).requestType === "TUTOR_RESPONSE_EVALUATION",
    ).length;

    expect(evaluationCallsAfter).toBe(evaluationCallsBefore); // detectExplicitDontKnow short-circuits before any evaluation call
    expect(events.some((e) => e.type === "complete")).toBe(true);
  });
});
