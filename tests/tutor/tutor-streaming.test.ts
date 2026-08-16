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
import { checkRateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { startTutorSession, submitTutorMessage, streamTutorMessage, type TutorStreamEvent } from "@/lib/tutor/tutor-orchestrator";
import { POST as postTutorMessage } from "@/app/api/tutor/sessions/[id]/messages/route";

interface MockCallOptions {
  requestType: string;
}

/**
 * A minimal fake `MessageStream` matching the shape `tutor-evaluator.ts`'s
 * streaming generators actually consume (`for await` over
 * `content_block_delta` / `text_delta` events) — nothing more, since that's
 * the only surface `streamText()` callers rely on (Phase 11 §2).
 */
function fakeTextStream(chunks: string[], opts: { throwAfter?: number; signal?: AbortSignal } = {}) {
  async function* gen() {
    for (let i = 0; i < chunks.length; i++) {
      if (opts.signal?.aborted) {
        const err = new Error("The user aborted a request.");
        err.name = "AbortError";
        throw err;
      }
      if (opts.throwAfter === i) throw new Error("simulated mid-stream Claude failure");
      yield { type: "content_block_delta", delta: { type: "text_delta", text: chunks[i] } };
      await new Promise((resolve) => setTimeout(resolve, 0));
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
    switch (requestType) {
      case "TUTOR_RESPONSE_EVALUATION":
        return { data: nextEvaluation, usage };
      // startTutorSession's opening question still goes through the non-streaming generateContent path.
      case "TUTOR_SOCRATIC_MESSAGE":
        return { data: { message: "Mock opening question?" }, usage };
      default:
        throw new Error(`unmocked requestType ${requestType}`);
    }
  });

  vi.mocked(streamText).mockImplementation(() => fakeTextStream(["Mock ", "streamed ", "reply."]) as never);
}

async function drain(gen: AsyncGenerator<TutorStreamEvent, void, void>): Promise<TutorStreamEvent[]> {
  const events: TutorStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe("tutor streaming (Phase 11)", () => {
  let userId: string;
  let courseId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-tutor-stream-${suffix}@example.com` } });
    userId = user.id;
    const course = await prisma.course.create({ data: { userId, title: `Tutor Stream ${suffix}` } });
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

  async function newSession(name: string) {
    const concept = await prisma.concept.create({ data: { courseId, name, normalizedName: name.toLowerCase() } });
    const { session } = await startTutorSession({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });
    return { concept, session };
  }

  it("existing non-streaming submitTutorMessage still behaves correctly after the prepareTurn/finalizeTurn refactor", async () => {
    const { session } = await newSession("Refactor Sanity");
    nextEvaluation.classification = "CORRECT";
    const result = await submitTutorMessage({ sessionId: session.id, userId, content: "A correct answer." });
    expect(["ASK_FOLLOWUP", "DEEPEN", "INCREASE_DIFFICULTY"]).toContain(result.session.currentStep);
    const attempts = await prisma.learningAttempt.count({ where: { userId, conceptId: session.conceptId } });
    expect(attempts).toBe(1);
  });

  it("emits delta events that reconstruct the persisted TutorMessage content, and TutorEngine's decision is unchanged", async () => {
    const { session } = await newSession("Delta Emission");
    nextEvaluation.classification = "CORRECT";

    const events = await drain(streamTutorMessage({ sessionId: session.id, userId, content: "A correct answer." }));

    const start = events.find((e) => e.type === "start");
    expect(start).toBeDefined();
    if (start?.type === "start") {
      expect(["ASK_FOLLOWUP", "DEEPEN", "INCREASE_DIFFICULTY"]).toContain(start.action);
      expect(start.aiGenerated).toBe(true);
    }

    const deltas = events.filter((e) => e.type === "delta").map((e) => (e.type === "delta" ? e.text : ""));
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.join("")).toBe("Mock streamed reply.");

    const complete = events.find((e) => e.type === "complete");
    expect(complete).toBeDefined();
    if (complete?.type === "complete") {
      expect(complete.message.content).toBe("Mock streamed reply.");
      expect(complete.message.role).toBe("TUTOR");
    }

    const metadataEvent = events.find((e) => e.type === "metadata");
    expect(metadataEvent).toBeDefined();
  });

  it("persists exactly one TutorMessage and does not duplicate the student's message", async () => {
    const { session } = await newSession("Single Persist");
    nextEvaluation.classification = "CORRECT";

    const studentBefore = await prisma.tutorMessage.count({ where: { sessionId: session.id, role: "STUDENT" } });
    const tutorBefore = await prisma.tutorMessage.count({ where: { sessionId: session.id, role: "TUTOR" } });

    await drain(streamTutorMessage({ sessionId: session.id, userId, content: "A correct answer." }));

    const studentAfter = await prisma.tutorMessage.count({ where: { sessionId: session.id, role: "STUDENT" } });
    const tutorAfter = await prisma.tutorMessage.count({ where: { sessionId: session.id, role: "TUTOR" } });
    expect(studentAfter - studentBefore).toBe(1);
    expect(tutorAfter - tutorBefore).toBe(1);

    // Draining an already-exhausted async generator again must not persist a second time.
    const gen = streamTutorMessage({ sessionId: session.id, userId, content: "" });
    await gen.next().catch(() => undefined);
    const secondDrainResult = await gen.next();
    expect(secondDrainResult.done).toBe(true);
  });

  it("a mid-stream Claude failure yields an error event and persists no TutorMessage", async () => {
    const { session } = await newSession("Mid Stream Failure");
    nextEvaluation.classification = "CORRECT";
    vi.mocked(streamText).mockImplementation(() => fakeTextStream(["Partial start… ", "should never arrive"], { throwAfter: 1 }) as never);

    const tutorBefore = await prisma.tutorMessage.count({ where: { sessionId: session.id, role: "TUTOR" } });
    const sessionBefore = await prisma.tutorSession.findUniqueOrThrow({ where: { id: session.id } });

    const events = await drain(streamTutorMessage({ sessionId: session.id, userId, content: "A correct answer." }));

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "complete")).toBe(false);

    const tutorAfter = await prisma.tutorMessage.count({ where: { sessionId: session.id, role: "TUTOR" } });
    expect(tutorAfter).toBe(tutorBefore);

    const sessionAfter = await prisma.tutorSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(sessionAfter.currentStep).toBe(sessionBefore.currentStep);
    expect(sessionAfter.questionsAnswered).toBe(sessionBefore.questionsAnswered);
  });

  it("an immediate (pre-any-text) Claude failure falls back to a deterministic message, exactly like the non-streaming path", async () => {
    const { session } = await newSession("Immediate Failure Fallback");
    nextEvaluation.classification = "CORRECT";
    vi.mocked(streamText).mockImplementation(() => fakeTextStream([], { throwAfter: 0 }) as never);

    const events = await drain(streamTutorMessage({ sessionId: session.id, userId, content: "A correct answer." }));
    const complete = events.find((e) => e.type === "complete");
    expect(complete).toBeDefined();
    if (complete?.type === "complete") {
      expect(complete.message.content.length).toBeGreaterThan(0);
    }
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("non-AI actions (COMPLETE) return without any fake delta events", async () => {
    const { session } = await newSession("Non AI Complete");
    nextEvaluation.classification = "CORRECT";
    await submitTutorMessage({ sessionId: session.id, userId, content: "Correct answer one." });

    nextEvaluation.classification = "CORRECT";
    const events = await drain(streamTutorMessage({ sessionId: session.id, userId, content: "Correct answer two." }));

    const start = events.find((e) => e.type === "start");
    expect(start).toBeDefined();
    if (start?.type === "start") {
      expect(start.action).toBe("COMPLETE");
      expect(start.aiGenerated).toBe(false);
    }
    expect(events.filter((e) => e.type === "delta")).toHaveLength(0);

    const complete = events.find((e) => e.type === "complete");
    expect(complete).toBeDefined();
    if (complete?.type === "complete") {
      expect(complete.session.status).toBe("COMPLETED");
    }
  });

  it("cancellation stops generation and persists no TutorMessage", async () => {
    const { session } = await newSession("Cancellation");
    nextEvaluation.classification = "CORRECT";
    const controller = new AbortController();
    vi.mocked(streamText).mockImplementation((options) => fakeTextStream(["First chunk. ", "Second chunk."], { signal: options.signal }) as never);

    const tutorBefore = await prisma.tutorMessage.count({ where: { sessionId: session.id, role: "TUTOR" } });

    const events: TutorStreamEvent[] = [];
    for await (const event of streamTutorMessage({ sessionId: session.id, userId, content: "A correct answer.", signal: controller.signal })) {
      events.push(event);
      if (event.type === "delta") controller.abort();
    }

    expect(events.some((e) => e.type === "complete")).toBe(false);
    const tutorAfter = await prisma.tutorMessage.count({ where: { sessionId: session.id, role: "TUTOR" } });
    expect(tutorAfter).toBe(tutorBefore);
  });

  it("the streaming route returns a text/event-stream response whose body carries start/delta/complete SSE frames", async () => {
    const user = await getCurrentUser();
    const course = await prisma.course.create({ data: { userId: user.id, title: "Route Stream Course" } });
    const concept = await prisma.concept.create({ data: { courseId: course.id, name: "Route Concept", normalizedName: "route-concept" } });
    const { session } = await startTutorSession({ userId: user.id, courseId: course.id, conceptId: concept.id, mode: "SOCRATIC" });
    nextEvaluation.classification = "CORRECT";

    const request = new Request(`http://localhost/api/tutor/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "A correct answer." }),
    });
    const response = await postTutorMessage(request, { params: Promise.resolve({ id: session.id }) });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.body).not.toBeNull();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      raw += decoder.decode(chunk.value, { stream: true });
    }

    const eventTypes = raw
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice("data: ".length)).type);

    expect(eventTypes[0]).toBe("start");
    expect(eventTypes).toContain("delta");
    expect(eventTypes[eventTypes.length - 1]).toBe("complete");

    await prisma.course.delete({ where: { id: course.id } });
  });

  // Runs last deliberately: it exhausts the real rate-limit bucket for the dev user's
  // "tutor-message" key, which would make any later request in this suite see a 429 too.
  it("the streaming route enforces the same rate limit before opening a stream", async () => {
    const user = await getCurrentUser();
    const key = `${user.id}:tutor-message`;
    for (let i = 0; i < 30; i++) checkRateLimit(key, { maxRequests: 30, windowMs: 60_000 });
    const blocked = checkRateLimit(key, { maxRequests: 30, windowMs: 60_000 });
    expect(blocked.allowed).toBe(false);

    const request = new Request("http://localhost/api/tutor/sessions/whatever/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    const response = await postTutorMessage(request, { params: Promise.resolve({ id: "whatever" }) });
    expect(response.status).toBe(429);
    expect(response.headers.get("Content-Type")).not.toContain("text/event-stream");
  });
});
