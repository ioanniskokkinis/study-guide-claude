import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/claude")>("@/lib/ai/claude");
  return { ...actual, extractStructured: vi.fn() };
});

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import { ensurePrefetchBuffer, invalidateStaleBufferForConcept } from "@/lib/learning/question-prefetch";
import { env } from "@/lib/env";

const QUESTION_PROMPTS = [
  "What does a stateful firewall track?",
  "Explain connection state tracking.",
  "How does a stateful firewall decide to allow a packet?",
  "Describe the purpose of state tracking.",
  "What happens when a stateful firewall sees an unexpected packet?",
  "Why does connection state improve accuracy?",
  "What is retained about a session by a stateful firewall?",
];

/**
 * Phase 17 §4-11/§22-30/§55 — the background question-prefetch buffer. Every
 * test here reuses the real adaptive engine and the real
 * getOrGenerateQuestion/duplicate-detection pipeline (only the Claude call
 * itself is mocked) — this is deliberately not a second, parallel
 * question-generation path.
 */
describe("question-prefetch", () => {
  let userId: string;
  let courseId: string;
  let conceptId: string;
  let chunkId: string;
  let promptIndex = 0;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-prefetch-${suffix}@example.com` } });
    userId = user.id;

    const course = await prisma.course.create({ data: { userId, title: "Networking", knowledgeStatus: "READY" } });
    courseId = course.id;

    const concept = await prisma.concept.create({
      data: { courseId, name: "Firewalls", normalizedName: "firewalls", description: "Filters traffic.", difficulty: 2 },
    });
    conceptId = concept.id;

    const document = await prisma.document.create({
      data: {
        courseId,
        filename: "f.pdf",
        originalFilename: "lecture.pdf",
        mimeType: "application/pdf",
        fileSize: 10,
        type: "pdf",
        storagePath: "x/y.pdf",
        processingStatus: "READY",
      },
    });
    const chunk = await prisma.documentChunk.create({
      data: { documentId: document.id, text: "Stateful firewalls track connection state.", chunkIndex: 0, tokenCount: 10 },
    });
    chunkId = chunk.id;

    await prisma.conceptSource.create({
      data: { conceptId, documentChunkId: chunk.id, evidence: "Stateful firewalls track connection state." },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  beforeEach(() => {
    vi.mocked(extractStructured).mockReset();
    vi.mocked(extractStructured).mockImplementation(async (options: { requestType: string }) => {
      if (options.requestType === "QUESTION_GENERATION" || options.requestType === "ACTIVE_RECALL_QUESTION_PREFETCH") {
        return {
          data: {
            canGenerate: true,
            prompt: QUESTION_PROMPTS[promptIndex++ % QUESTION_PROMPTS.length],
            expectedAnswer: "Connection state.",
            rubric: ["Mentions connection state"],
            sourceChunkIds: [chunkId],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      throw new Error(`unmocked requestType ${options.requestType}`);
    });
  });

  async function createSession(targetLength = 10) {
    const session = await prisma.studySession.create({ data: { userId, courseId, targetLength } });
    const question = await prisma.question.create({
      data: {
        courseId,
        conceptId,
        type: "RECALL",
        difficulty: 1,
        prompt: "Seed question.",
        normalizedPrompt: "seed question",
        expectedAnswer: "Connection state.",
        rubric: ["Mentions connection state"],
        sourceReferences: [chunkId],
      },
    });
    await prisma.studySessionQuestion.create({ data: { sessionId: session.id, questionId: question.id, position: 1 } });
    return session;
  }

  it("tops up the buffer to ACTIVE_RECALL_PREFETCH_COUNT ready questions", async () => {
    const session = await createSession();
    await ensurePrefetchBuffer(session.id, userId);

    const ready = await prisma.studySessionQuestion.count({ where: { sessionId: session.id, answeredAt: null } });
    // The seeded question already counts toward the buffer target — total ready caps at the configured size, it isn't additive on top of it.
    expect(ready).toBe(env.ACTIVE_RECALL_PREFETCH_COUNT);
  });

  it("is idempotent — calling it again once full generates nothing new", async () => {
    const session = await createSession();
    await ensurePrefetchBuffer(session.id, userId);
    const callsAfterFirstFill = vi.mocked(extractStructured).mock.calls.length;

    await ensurePrefetchBuffer(session.id, userId);
    expect(vi.mocked(extractStructured).mock.calls.length).toBe(callsAfterFirstFill);
  });

  it("never prefetches more than the session's remaining target length", async () => {
    const session = await createSession(2); // 1 seeded + at most 1 more should ever be buffered
    await ensurePrefetchBuffer(session.id, userId);

    const total = await prisma.studySessionQuestion.count({ where: { sessionId: session.id } });
    expect(total).toBeLessThanOrEqual(2);
  });

  it("isolates a generation failure — a broken call doesn't crash the buffer or the session", async () => {
    const session = await createSession();
    vi.mocked(extractStructured).mockRejectedValue(new Error("simulated Claude failure"));

    await expect(ensurePrefetchBuffer(session.id, userId)).resolves.toBeUndefined();

    const stillActive = await prisma.studySession.findUniqueOrThrow({ where: { id: session.id } });
    expect(stillActive.status).toBe("ACTIVE");
  });

  it("prefetched questions belong to the correct course and session", async () => {
    const session = await createSession();
    await ensurePrefetchBuffer(session.id, userId);

    const rows = await prisma.studySessionQuestion.findMany({
      where: { sessionId: session.id, answeredAt: null },
      include: { question: true },
    });
    for (const row of rows) {
      expect(row.question.courseId).toBe(courseId);
    }
  });

  it("does not duplicate an already-buffered question when called concurrently (idempotent generation)", async () => {
    const session = await createSession();
    await Promise.all([ensurePrefetchBuffer(session.id, userId), ensurePrefetchBuffer(session.id, userId)]);

    const rows = await prisma.studySessionQuestion.findMany({ where: { sessionId: session.id }, select: { questionId: true } });
    const uniqueQuestionIds = new Set(rows.map((r) => r.questionId));
    expect(uniqueQuestionIds.size).toBe(rows.length);
  });

  it("invalidateStaleBufferForConcept discards unserved buffered questions for that concept and refills", async () => {
    const session = await createSession();
    await ensurePrefetchBuffer(session.id, userId);
    const beforeIds = (
      await prisma.studySessionQuestion.findMany({ where: { sessionId: session.id, answeredAt: null }, select: { id: true } })
    ).map((r) => r.id);
    expect(beforeIds.length).toBeGreaterThan(0);

    await invalidateStaleBufferForConcept(session.id, conceptId, userId);

    const afterIds = (
      await prisma.studySessionQuestion.findMany({ where: { sessionId: session.id, answeredAt: null }, select: { id: true } })
    ).map((r) => r.id);
    // Every previously-buffered id was discarded (not just left in place) — the refill produced entirely new rows.
    expect(afterIds.some((id) => beforeIds.includes(id))).toBe(false);
  });

  it("never touches already-answered questions when invalidating", async () => {
    const session = await createSession();
    const answered = await prisma.studySessionQuestion.findFirstOrThrow({ where: { sessionId: session.id } });
    await prisma.studySessionQuestion.update({ where: { id: answered.id }, data: { answeredAt: new Date() } });

    await invalidateStaleBufferForConcept(session.id, conceptId, userId);

    const stillThere = await prisma.studySessionQuestion.findUnique({ where: { id: answered.id } });
    expect(stillThere).not.toBeNull();
  });
});
