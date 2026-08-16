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
import { getCurrentUser } from "@/lib/auth/dev-user";
import {
  prepareTutorSessionStart,
  streamTutorSessionStart,
  streamTutorHint,
  requestTutorHint,
  type TutorStreamEvent,
} from "@/lib/tutor/tutor-orchestrator";
import { POST as postSessions } from "@/app/api/tutor/sessions/route";
import { POST as postHint } from "@/app/api/tutor/sessions/[id]/hint/route";

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

function resetMocks() {
  vi.mocked(extractStructured).mockImplementation(async () => {
    throw new Error("extractStructured should not be called by any Phase 13 streaming path");
  });
  vi.mocked(streamText).mockImplementation(() => fakeTextStream(["Mock ", "opening ", "text."]) as never);
}

async function drain(gen: AsyncGenerator<TutorStreamEvent, void, void>): Promise<TutorStreamEvent[]> {
  const events: TutorStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe("session start + hint streaming (Phase 13)", () => {
  let userId: string;
  let courseId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-p13-${suffix}@example.com` } });
    userId = user.id;
    const course = await prisma.course.create({ data: { userId, title: `Phase13 ${suffix}` } });
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

  async function newConcept(name: string) {
    return prisma.concept.create({ data: { courseId, name, normalizedName: name.toLowerCase().replace(/\s+/g, "-") } });
  }

  describe("streamTutorSessionStart", () => {
    it("streams start/delta/metadata/complete for a fresh session and persists exactly one session and one message", async () => {
      const concept = await newConcept("Session Start Fresh");
      const outcome = await prepareTutorSessionStart({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });
      expect(outcome.kind).toBe("prepared");
      if (outcome.kind !== "prepared") return;

      const events = await drain(streamTutorSessionStart(outcome.prepared, { requestStartedAt: Date.now(), decisionMs: 5 }));

      expect(events[0].type).toBe("start");
      const deltas = events.filter((e) => e.type === "delta");
      expect(deltas.length).toBeGreaterThan(0);
      const complete = events.find((e) => e.type === "complete");
      expect(complete).toBeDefined();
      if (complete?.type === "complete") {
        expect(complete.message.role).toBe("TUTOR");
        expect(complete.message.content).toBe("Mock opening text.");
      }
      expect(events.filter((e) => e.type === "complete")).toHaveLength(1);

      const sessionCount = await prisma.tutorSession.count({ where: { userId, courseId, conceptId: concept.id } });
      const messageCount = await prisma.tutorMessage.count({ where: { session: { conceptId: concept.id } } });
      expect(sessionCount).toBe(1);
      expect(messageCount).toBe(1);
    });

    it("prepareTutorSessionStart resumes without streaming once a session already has its opening message", async () => {
      const concept = await newConcept("Session Resume");
      const first = await prepareTutorSessionStart({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });
      if (first.kind !== "prepared") throw new Error("expected prepared");
      await drain(streamTutorSessionStart(first.prepared, { requestStartedAt: Date.now(), decisionMs: 5 }));

      const streamTextCallsBefore = vi.mocked(streamText).mock.calls.length;
      const second = await prepareTutorSessionStart({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });
      expect(second.kind).toBe("resumed");
      if (second.kind === "resumed") {
        expect(second.result.messages).toHaveLength(1);
        expect(second.result.session.id).toBe(first.prepared.session.id);
      }
      // Resuming must never call Claude — nothing to generate.
      expect(vi.mocked(streamText).mock.calls.length).toBe(streamTextCallsBefore);
    });

    it("an orphaned session (created but never given its opening message) is reused instead of duplicated", async () => {
      const concept = await newConcept("Session Orphan");
      const orphan = await prisma.tutorSession.create({
        data: { userId, courseId, conceptId: concept.id, mode: "SOCRATIC", difficulty: 1, status: "ACTIVE" },
      });

      const outcome = await prepareTutorSessionStart({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });
      expect(outcome.kind).toBe("prepared");
      if (outcome.kind !== "prepared") return;
      expect(outcome.prepared.session.id).toBe(orphan.id);

      await drain(streamTutorSessionStart(outcome.prepared, { requestStartedAt: Date.now(), decisionMs: 5 }));

      const sessionCount = await prisma.tutorSession.count({ where: { userId, courseId, conceptId: concept.id } });
      expect(sessionCount).toBe(1);
      const messageCount = await prisma.tutorMessage.count({ where: { sessionId: orphan.id } });
      expect(messageCount).toBe(1);
    });

    it("cancellation persists no TutorMessage and leaves exactly one (orphaned) session row for a later retry", async () => {
      const concept = await newConcept("Session Cancel");
      const outcome = await prepareTutorSessionStart({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });
      if (outcome.kind !== "prepared") throw new Error("expected prepared");

      const controller = new AbortController();
      vi.mocked(streamText).mockImplementation((options) => fakeTextStream(["First. ", "Second."], { signal: options.signal }) as never);

      const events: TutorStreamEvent[] = [];
      for await (const event of streamTutorSessionStart(
        outcome.prepared,
        { requestStartedAt: Date.now(), decisionMs: 5 },
        controller.signal,
      )) {
        events.push(event);
        if (event.type === "delta") controller.abort();
      }

      expect(events.some((e) => e.type === "complete")).toBe(false);
      const messageCount = await prisma.tutorMessage.count({ where: { sessionId: outcome.prepared.session.id } });
      expect(messageCount).toBe(0);
      const sessionCount = await prisma.tutorSession.count({ where: { userId, courseId, conceptId: concept.id } });
      expect(sessionCount).toBe(1);
    });

    it("a mid-stream Claude failure yields an error event and persists nothing", async () => {
      const concept = await newConcept("Session Mid Failure");
      const outcome = await prepareTutorSessionStart({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });
      if (outcome.kind !== "prepared") throw new Error("expected prepared");
      vi.mocked(streamText).mockImplementation(() => fakeTextStream(["Partial. ", "unreachable"], { throwAfter: 1 }) as never);

      const events = await drain(streamTutorSessionStart(outcome.prepared, { requestStartedAt: Date.now(), decisionMs: 5 }));
      expect(events.some((e) => e.type === "error")).toBe(true);
      expect(events.some((e) => e.type === "complete")).toBe(false);
      const messageCount = await prisma.tutorMessage.count({ where: { sessionId: outcome.prepared.session.id } });
      expect(messageCount).toBe(0);
    });
  });

  describe("streamTutorHint", () => {
    async function startedSession(name: string) {
      const concept = await newConcept(name);
      const outcome = await prepareTutorSessionStart({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });
      if (outcome.kind !== "prepared") throw new Error("expected prepared");
      const result = await drain(streamTutorSessionStart(outcome.prepared, { requestStartedAt: Date.now(), decisionMs: 5 }));
      const complete = result.find((e) => e.type === "complete");
      if (complete?.type !== "complete") throw new Error("session start did not complete");
      return { concept, session: complete.session };
    }

    it("streams start/delta/metadata/complete for HINT_1 and increments hintLevel exactly once", async () => {
      const { session } = await startedSession("Hint Level 1");
      vi.mocked(streamText).mockImplementation(() => fakeTextStream(["Think ", "about ", "it."]) as never);

      const events = await drain(streamTutorHint(session.id, userId));
      const start = events.find((e) => e.type === "start");
      expect(start).toBeDefined();
      if (start?.type === "start") expect(start.action).toBe("GIVE_HINT");

      const deltas = events.filter((e) => e.type === "delta");
      expect(deltas.length).toBeGreaterThan(0);

      const complete = events.find((e) => e.type === "complete");
      expect(complete).toBeDefined();
      if (complete?.type === "complete") {
        expect(complete.message.messageType).toBe("HINT");
        expect(complete.message.content).toBe("Think about it.");
        expect(complete.session.hintLevel).toBe(1);
      }

      const updated = await prisma.tutorSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(updated.hintLevel).toBe(1);
      expect(updated.hintsUsedTotal).toBe(1);
    });

    it("escalates to REVEAL (GIVE_EXPLANATION) at hint level 4, matching the non-streaming path's progression", async () => {
      const { session } = await startedSession("Hint Escalation");
      vi.mocked(streamText).mockImplementation(() => fakeTextStream(["hint text"]) as never);

      // Drive hintLevel 0->1->2->3 via the streaming path, then expect the 4th to reveal.
      await drain(streamTutorHint(session.id, userId));
      await drain(streamTutorHint(session.id, userId));
      await drain(streamTutorHint(session.id, userId));
      vi.mocked(streamText).mockImplementation(() => fakeTextStream(["core ", "idea. ", "For example: x. ", "connects. ", "check?"]) as never);
      const events = await drain(streamTutorHint(session.id, userId));

      const start = events.find((e) => e.type === "start");
      if (start?.type === "start") expect(start.action).toBe("GIVE_EXPLANATION");
      const complete = events.find((e) => e.type === "complete");
      if (complete?.type === "complete") {
        expect(complete.message.messageType).toBe("EXPLANATION");
        expect(complete.session.hintLevel).toBe(4);
        expect(complete.session.answerRevealed).toBe(true);
      }
    });

    it("cancellation persists no TutorMessage and leaves hintLevel unchanged", async () => {
      const { session } = await startedSession("Hint Cancel");
      const controller = new AbortController();
      vi.mocked(streamText).mockImplementation((options) => fakeTextStream(["First. ", "Second."], { signal: options.signal }) as never);

      const before = await prisma.tutorSession.findUniqueOrThrow({ where: { id: session.id } });
      const events: TutorStreamEvent[] = [];
      for await (const event of streamTutorHint(session.id, userId, controller.signal)) {
        events.push(event);
        if (event.type === "delta") controller.abort();
      }

      expect(events.some((e) => e.type === "complete")).toBe(false);
      const after = await prisma.tutorSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(after.hintLevel).toBe(before.hintLevel);
      const tutorMessageCount = await prisma.tutorMessage.count({ where: { sessionId: session.id, role: "TUTOR", messageType: "HINT" } });
      expect(tutorMessageCount).toBe(0);
    });

    it("a mid-stream failure yields an error event and does not increment hintLevel", async () => {
      const { session } = await startedSession("Hint Mid Failure");
      vi.mocked(streamText).mockImplementation(() => fakeTextStream(["Partial. ", "unreachable"], { throwAfter: 1 }) as never);

      const before = await prisma.tutorSession.findUniqueOrThrow({ where: { id: session.id } });
      const events = await drain(streamTutorHint(session.id, userId));
      expect(events.some((e) => e.type === "error")).toBe(true);
      const after = await prisma.tutorSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(after.hintLevel).toBe(before.hintLevel);
    });

    it("the non-streaming requestTutorHint still behaves identically after the prepareHint/finalizeHint refactor", async () => {
      const { session } = await startedSession("Hint Non Streaming");
      vi.mocked(extractStructured).mockImplementation(async () => ({ data: { message: "Non-streaming hint." }, usage: { inputTokens: 1, outputTokens: 1 } }));
      const result = await requestTutorHint(session.id, userId);
      expect(result.message.messageType).toBe("HINT");
      expect(result.session.hintLevel).toBe(1);
    });
  });

  describe("route-level: one shared SSE mechanism", () => {
    it("POST /api/tutor/sessions streams a fresh start as SSE with start/delta/complete frames", async () => {
      const user = await getCurrentUser();
      const course = await prisma.course.create({ data: { userId: user.id, title: "Route Session Start" } });
      const concept = await prisma.concept.create({ data: { courseId: course.id, name: "Route Concept", normalizedName: "route-concept-start" } });

      const request = new Request("http://localhost/api/tutor/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId: course.id, conceptId: concept.id, mode: "SOCRATIC" }),
      });
      const response = await postSessions(request);

      expect(response.status).toBe(201);
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

    it("POST /api/tutor/sessions returns plain JSON (not a stream) when resuming an already-started session", async () => {
      const user = await getCurrentUser();
      const course = await prisma.course.create({ data: { userId: user.id, title: "Route Session Resume" } });
      const concept = await prisma.concept.create({ data: { courseId: course.id, name: "Resume Concept", normalizedName: "route-concept-resume" } });

      const firstRequest = new Request("http://localhost/api/tutor/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId: course.id, conceptId: concept.id, mode: "SOCRATIC" }),
      });
      const firstResponse = await postSessions(firstRequest);
      // Drain the first (fresh-start) stream so the opening message actually gets persisted.
      const reader = firstResponse.body!.getReader();
      while (!(await reader.read()).done) {
        /* drain */
      }

      const secondRequest = new Request("http://localhost/api/tutor/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId: course.id, conceptId: concept.id, mode: "SOCRATIC" }),
      });
      const secondResponse = await postSessions(secondRequest);
      expect(secondResponse.status).toBe(200);
      expect(secondResponse.headers.get("Content-Type") ?? "").not.toContain("text/event-stream");
      const body = await secondResponse.json();
      expect(body.messages).toHaveLength(1);

      await prisma.course.delete({ where: { id: course.id } });
    });

    it("POST /hint streams as SSE using the same protocol shape", async () => {
      const user = await getCurrentUser();
      const course = await prisma.course.create({ data: { userId: user.id, title: "Route Hint" } });
      const concept = await prisma.concept.create({ data: { courseId: course.id, name: "Route Hint Concept", normalizedName: "route-hint-concept" } });
      const outcome = await prepareTutorSessionStart({ userId: user.id, courseId: course.id, conceptId: concept.id, mode: "SOCRATIC" });
      if (outcome.kind !== "prepared") throw new Error("expected prepared");
      await drain(streamTutorSessionStart(outcome.prepared, { requestStartedAt: Date.now(), decisionMs: 5 }));

      const request = new Request(`http://localhost/api/tutor/sessions/${outcome.prepared.session.id}/hint`, { method: "POST" });
      const response = await postHint(request, { params: Promise.resolve({ id: outcome.prepared.session.id }) });

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");

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
      expect(eventTypes[eventTypes.length - 1]).toBe("complete");

      await prisma.course.delete({ where: { id: course.id } });
    });
  });
});
