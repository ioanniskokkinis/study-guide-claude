import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/claude")>("@/lib/ai/claude");
  return { ...actual, extractStructured: vi.fn() };
});

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import { buildKnowledgeGraph } from "@/lib/knowledge/knowledge-builder";
import { triggerKnowledgeBuild, KnowledgeBuildInProgressError, getKnowledgeProgress } from "@/lib/services/knowledge";

/**
 * Production-hardening phase §A1-A8, §L, §N — real progress, partial
 * recovery when relationships/prerequisites fail, and the concurrency
 * guard that prevents two simultaneous builds for the same course.
 */
async function seedCourseWithReadyChunk(userId: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const course = await prisma.course.create({ data: { userId, title: `KB Course ${suffix}` } });
  const document = await prisma.document.create({
    data: {
      courseId: course.id,
      filename: `f-${suffix}.pdf`,
      originalFilename: `Notes ${suffix}.pdf`,
      mimeType: "application/pdf",
      fileSize: 10,
      type: "pdf",
      storagePath: `kb-fixture/${suffix}.pdf`,
      processingStatus: "READY",
    },
  });
  await prisma.documentChunk.create({
    data: { documentId: document.id, text: "TCP establishes connections. Ports identify services.", chunkIndex: 0, tokenCount: 8 },
  });
  return course;
}

/** Waits for a fire-and-forget buildKnowledgeGraph job to leave QUEUED/PROCESSING, so background work never outlives the test that started it (and races the next test's/describe's cleanup). */
async function waitForBuildToSettle(courseId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const course = await prisma.course.findUniqueOrThrow({ where: { id: courseId }, select: { knowledgeStatus: true } });
    if (course.knowledgeStatus !== "QUEUED" && course.knowledgeStatus !== "PROCESSING") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Build for course ${courseId} did not settle within ${timeoutMs}ms`);
}

describe("buildKnowledgeGraph", () => {
  let userId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `kb-${suffix}@example.com` } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  afterEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  it("builds successfully, ending at 100% progress and stage complete", async () => {
    const course = await seedCourseWithReadyChunk(userId);
    vi.mocked(extractStructured).mockImplementation(async (options) => {
      if (options.requestType === "concept_extraction") {
        // Evidence must reference the real chunk; fetch it so the hallucination guard doesn't drop it.
        const chunk = await prisma.documentChunk.findFirstOrThrow({ where: { document: { courseId: course.id } } });
        return { data: { concepts: [{ name: "TCP", description: "...", difficulty: 2, evidence: [{ chunkId: chunk.id, text: "x" }] }] }, usage: { inputTokens: 1, outputTokens: 1 } };
      }
      if (options.requestType === "concept_dedup") return { data: { duplicateGroups: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
      if (options.requestType === "relationship_extraction") return { data: { relationships: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
      if (options.requestType === "prerequisite_analysis") return { data: { prerequisites: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
      throw new Error(`unexpected requestType ${options.requestType}`);
    });

    const summary = await buildKnowledgeGraph(course.id, { userId });
    expect(summary.conceptsCreated).toBe(1);
    expect(summary.errors).toEqual([]);

    const row = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
    expect(row.knowledgeStatus).toBe("READY");
    expect(row.knowledgeProgress).toBe(100);
    expect(row.knowledgeStage).toBe("complete");
    expect(row.knowledgeError).toBeNull();
  });

  it("persists concepts even when relationship/prerequisite analysis fails entirely (partial recovery, §A7)", async () => {
    const course = await seedCourseWithReadyChunk(userId);
    vi.mocked(extractStructured).mockImplementation(async (options) => {
      if (options.requestType === "concept_extraction") {
        const chunk = await prisma.documentChunk.findFirstOrThrow({ where: { document: { courseId: course.id } } });
        return { data: { concepts: [{ name: "TCP", description: "...", difficulty: 2, evidence: [{ chunkId: chunk.id, text: "x" }] }] }, usage: { inputTokens: 1, outputTokens: 1 } };
      }
      if (options.requestType === "concept_dedup") return { data: { duplicateGroups: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
      // Relationships and prerequisites are unrecoverably broken this run.
      throw new Error("Failed to parse structured output as JSON: Unterminated string");
    });

    const summary = await buildKnowledgeGraph(course.id, { userId });
    expect(summary.conceptsCreated).toBe(1);
    expect(summary.relationshipsCreated).toBe(0);

    const row = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
    // Concepts were saved — the course is still READY (browsable), not FAILED (hidden).
    expect(row.knowledgeStatus).toBe("READY");
    const conceptCount = await prisma.concept.count({ where: { courseId: course.id } });
    expect(conceptCount).toBe(1);
  });

  it("marks the build FAILED (never silently) when no documents are ready", async () => {
    const course = await prisma.course.create({ data: { userId, title: "Empty course" } });
    const summary = await buildKnowledgeGraph(course.id, { userId });
    expect(summary.errors.length).toBeGreaterThan(0);

    const row = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
    expect(row.knowledgeStatus).toBe("FAILED");
    expect(row.knowledgeError).toBeTruthy();
  });
});

describe("triggerKnowledgeBuild concurrency guard", () => {
  let userId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `kb-concurrency-${suffix}@example.com` } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  afterEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  it("rejects a second build while one is already QUEUED/PROCESSING for the same course (§L)", async () => {
    const course = await seedCourseWithReadyChunk(userId);
    // The concurrency guard is enforced by the atomic claim inside triggerKnowledgeBuild itself
    // (before the background job even runs), so the second call collides regardless of how the
    // background job's own AI calls behave — no need to keep it artificially pending.
    vi.mocked(extractStructured).mockRejectedValue(new Error("simulated failure"));

    const first = await triggerKnowledgeBuild(userId, course.id);
    expect(first).toEqual({ accepted: true });

    await expect(triggerKnowledgeBuild(userId, course.id)).rejects.toBeInstanceOf(KnowledgeBuildInProgressError);

    // Let the background job actually finish before this test (and the describe block's afterAll)
    // moves on — otherwise its own DB writes race the next cleanup step.
    await waitForBuildToSettle(course.id);
  });

  it("returns null for a course that doesn't exist or isn't owned by this user", async () => {
    expect(await triggerKnowledgeBuild(userId, "does-not-exist")).toBeNull();
  });
});

describe("getKnowledgeProgress", () => {
  let userId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `kb-progress-${suffix}@example.com` } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("returns null for a course that doesn't exist or isn't owned by this user", async () => {
    expect(await getKnowledgeProgress(userId, "does-not-exist")).toBeNull();
  });

  it("reflects the real persisted status/progress/stage fields", async () => {
    const course = await prisma.course.create({ data: { userId, title: "Progress course" } });
    await prisma.course.update({
      where: { id: course.id },
      data: { knowledgeStatus: "PROCESSING", knowledgeProgress: 42, knowledgeStage: "relationships", knowledgeStageMessage: "Finding relationships…" },
    });

    const progress = await getKnowledgeProgress(userId, course.id);
    expect(progress).toEqual({ status: "PROCESSING", progress: 42, stage: "relationships", message: "Finding relationships…", error: null });
  });
});
