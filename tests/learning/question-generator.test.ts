import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", () => ({ extractStructured: vi.fn() }));

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import { getOrGenerateQuestion } from "@/lib/learning/question-generator";

describe("getOrGenerateQuestion", () => {
  let userId: string;
  let courseId: string;
  let conceptId: string;
  let conceptWithNoSourcesId: string;
  let chunkId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-qgen-${suffix}@example.com` } });
    userId = user.id;

    const course = await prisma.course.create({ data: { userId, title: "Networking" } });
    courseId = course.id;

    const concept = await prisma.concept.create({
      data: { courseId, name: "Firewalls", normalizedName: "firewalls", description: "Filters traffic." },
    });
    conceptId = concept.id;

    const noSources = await prisma.concept.create({
      data: { courseId, name: "Unsourced", normalizedName: "unsourced", description: "No material yet." },
    });
    conceptWithNoSourcesId = noSources.id;

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
  });

  it("refuses to generate when the concept has no source material (spec §6 grounding requirement)", async () => {
    const question = await getOrGenerateQuestion({
      courseId,
      conceptId: conceptWithNoSourcesId,
      type: "RECALL",
      difficulty: 2,
      userId,
    });
    expect(question).toBeNull();
    expect(extractStructured).not.toHaveBeenCalled();
  });

  it("reuses an existing question at the same concept/type/difficulty instead of calling Claude again", async () => {
    const existing = await prisma.question.create({
      data: {
        courseId,
        conceptId,
        type: "APPLY",
        difficulty: 3,
        prompt: "A packet arrives mid-session with an unexpected flag. What should the firewall do?",
        normalizedPrompt: "a packet arrives midsession with an unexpected flag what should the firewall do",
        expectedAnswer: "Reject it as it doesn't match expected session state.",
        rubric: ["Mentions session-state mismatch"],
        sourceReferences: [chunkId],
      },
    });

    const question = await getOrGenerateQuestion({ courseId, conceptId, type: "APPLY", difficulty: 3, userId });
    expect(question!.id).toBe(existing.id);
    expect(extractStructured).not.toHaveBeenCalled();
  });

  it("drops a citation to a chunk that was never actually provided (never trusts the model's cited sources)", async () => {
    vi.mocked(extractStructured).mockResolvedValue({
      data: {
        canGenerate: true,
        prompt: "What does a stateful firewall do when a packet doesn't match any session?",
        expectedAnswer: "It drops the packet.",
        rubric: ["Mentions dropping unmatched packets"],
        sourceChunkIds: ["hallucinated-chunk-id"],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const question = await getOrGenerateQuestion({ courseId, conceptId, type: "RECALL", difficulty: 1, userId });
    expect(question).toBeNull();
  });

  it("respects a refusal from the generator (canGenerate: false)", async () => {
    vi.mocked(extractStructured).mockResolvedValue({
      data: { canGenerate: false, refusalReason: "Not enough material." },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const question = await getOrGenerateQuestion({ courseId, conceptId, type: "TRANSFER", difficulty: 4, userId });
    expect(question).toBeNull();
  });

  it("rejects a near-duplicate of an existing question for the same concept (spec §24)", async () => {
    await prisma.question.create({
      data: {
        courseId,
        conceptId,
        type: "EXPLAIN",
        difficulty: 2,
        prompt: "Explain how a stateful firewall decides whether to allow a packet.",
        normalizedPrompt: "explain how a stateful firewall decides whether to allow a packet",
        expectedAnswer: "It checks the packet against tracked connection state.",
        rubric: ["Mentions connection state lookup"],
        sourceReferences: [chunkId],
      },
    });

    vi.mocked(extractStructured).mockResolvedValue({
      data: {
        canGenerate: true,
        // Trivial rewording of the existing question — should be caught by the near-duplicate check.
        prompt: "Explain how a stateful firewall decides whether to allow a packet through.",
        expectedAnswer: "It checks the packet against tracked connection state.",
        rubric: ["Mentions connection state lookup"],
        sourceChunkIds: [chunkId],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const question = await getOrGenerateQuestion({ courseId, conceptId, type: "EXPLAIN", difficulty: 5, userId });
    expect(question).toBeNull();
  });

  it("persists a grounded, non-duplicate generated question", async () => {
    vi.mocked(extractStructured).mockResolvedValue({
      data: {
        canGenerate: true,
        prompt: "Why does a stateful firewall reject a packet with no matching session entry?",
        expectedAnswer: "Because it can't be verified against any tracked connection.",
        rubric: ["Mentions lack of matching session state"],
        sourceChunkIds: [chunkId],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const question = await getOrGenerateQuestion({ courseId, conceptId, type: "RECALL", difficulty: 2, userId });
    expect(question).not.toBeNull();
    expect(question!.conceptId).toBe(conceptId);
    expect(question!.sourceReferences).toEqual([chunkId]);

    const persisted = await prisma.question.findUnique({ where: { id: question!.id } });
    expect(persisted).not.toBeNull();
  });
});
