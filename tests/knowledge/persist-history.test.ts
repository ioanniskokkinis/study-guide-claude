import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/claude")>("@/lib/ai/claude");
  return { ...actual, extractStructured: vi.fn() };
});

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import { buildKnowledgeGraph } from "@/lib/knowledge/knowledge-builder";

/**
 * Phase 2 §R — the single most important regression in this phase: a
 * Knowledge Graph rebuild must never wipe a student's mastery, evidence,
 * review schedule, or other learning history. Concepts are matched by
 * normalized name and updated in place (same id) rather than deleted and
 * recreated; a genuinely renamed/merged concept gets its history migrated
 * via chunk-overlap before the old row is removed.
 */
async function seedCourseWithChunk(userId: string, text = "IP Addressing establishes host identity on a network.") {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const course = await prisma.course.create({ data: { userId, title: `History course ${suffix}` } });
  const document = await prisma.document.create({
    data: {
      courseId: course.id,
      filename: `f-${suffix}.pdf`,
      originalFilename: `Notes ${suffix}.pdf`,
      mimeType: "application/pdf",
      fileSize: 10,
      type: "pdf",
      storagePath: `history-fixture/${suffix}.pdf`,
      processingStatus: "READY",
    },
  });
  const chunk = await prisma.documentChunk.create({ data: { documentId: document.id, text, chunkIndex: 0, tokenCount: 8 } });
  return { course, document, chunk };
}

function mockPipeline(conceptName: string, chunkId: string) {
  vi.mocked(extractStructured).mockImplementation(async (options) => {
    if (options.requestType === "concept_extraction") {
      return { data: { concepts: [{ name: conceptName, description: "...", difficulty: 2, evidence: [{ chunkId, text: "x" }] }] }, usage: { inputTokens: 1, outputTokens: 1 } };
    }
    if (options.requestType === "concept_dedup") return { data: { duplicateGroups: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    if (options.requestType === "relationship_extraction") return { data: { relationships: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    if (options.requestType === "prerequisite_analysis") return { data: { prerequisites: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    throw new Error(`unexpected requestType ${options.requestType}`);
  });
}

describe("Knowledge Graph rebuild preserves student learning history", () => {
  let userId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `history-${suffix}@example.com` } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  afterEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  it("keeps the same concept id (and all its mastery/evidence/review history) across a rebuild that re-extracts the same concept name", async () => {
    const { course, chunk } = await seedCourseWithChunk(userId);
    mockPipeline("IP Addressing", chunk.id);
    await buildKnowledgeGraph(course.id, { userId });

    const conceptBefore = await prisma.concept.findFirstOrThrow({ where: { courseId: course.id } });

    const mastery = await prisma.studentConceptMastery.create({
      data: { userId, conceptId: conceptBefore.id, overallMastery: 0.72, exposureCount: 5, attemptCount: 5, successCount: 4, status: "STRONG" },
    });
    const evidence = await prisma.knowledgeEvidence.create({
      data: { userId, conceptId: conceptBefore.id, sourceType: "QUESTION", outcome: "SUCCESS", score: 0.8 },
    });
    const reviewItem = await prisma.reviewItem.create({
      data: { userId, courseId: course.id, conceptId: conceptBefore.id, status: "REVIEW", nextReviewAt: new Date(Date.now() + 3 * 86_400_000) },
    });

    // Rebuild again — same concept name, same source chunk (a normal "rebuild after re-uploading" scenario).
    mockPipeline("IP Addressing", chunk.id);
    await buildKnowledgeGraph(course.id, { userId });

    const conceptAfter = await prisma.concept.findFirstOrThrow({ where: { courseId: course.id } });
    expect(conceptAfter.id).toBe(conceptBefore.id);

    const masteryAfter = await prisma.studentConceptMastery.findUnique({ where: { id: mastery.id } });
    expect(masteryAfter).not.toBeNull();
    expect(masteryAfter!.overallMastery).toBe(0.72);
    expect(masteryAfter!.conceptId).toBe(conceptBefore.id);

    const evidenceAfter = await prisma.knowledgeEvidence.findUnique({ where: { id: evidence.id } });
    expect(evidenceAfter).not.toBeNull();

    const reviewItemAfter = await prisma.reviewItem.findUnique({ where: { id: reviewItem.id } });
    expect(reviewItemAfter).not.toBeNull();
    expect(reviewItemAfter!.conceptId).toBe(conceptBefore.id);
  });

  it("migrates mastery/evidence onto the new concept when a rebuild renames a concept sharing the same source chunk", async () => {
    const { course, chunk } = await seedCourseWithChunk(userId);
    mockPipeline("Subnetting Basics", chunk.id);
    await buildKnowledgeGraph(course.id, { userId });

    const oldConcept = await prisma.concept.findFirstOrThrow({ where: { courseId: course.id } });
    const mastery = await prisma.studentConceptMastery.create({
      data: { userId, conceptId: oldConcept.id, overallMastery: 0.55, exposureCount: 3, attemptCount: 3, successCount: 2, status: "DEVELOPING" },
    });
    const evidence = await prisma.knowledgeEvidence.create({
      data: { userId, conceptId: oldConcept.id, sourceType: "QUESTION", outcome: "PARTIAL", score: 0.5 },
    });

    // Rebuild with a re-worded name for what is, materially, the same concept (same source chunk).
    mockPipeline("Subnetting", chunk.id);
    await buildKnowledgeGraph(course.id, { userId });

    const newConcept = await prisma.concept.findFirstOrThrow({ where: { courseId: course.id } });
    expect(newConcept.id).not.toBe(oldConcept.id);
    expect(newConcept.name).toBe("Subnetting");

    const masteryAfter = await prisma.studentConceptMastery.findUnique({ where: { id: mastery.id } });
    expect(masteryAfter).not.toBeNull();
    expect(masteryAfter!.conceptId).toBe(newConcept.id);
    expect(masteryAfter!.overallMastery).toBe(0.55);

    const evidenceAfter = await prisma.knowledgeEvidence.findUnique({ where: { id: evidence.id } });
    expect(evidenceAfter).not.toBeNull();
    expect(evidenceAfter!.conceptId).toBe(newConcept.id);

    const oldConceptRow = await prisma.concept.findUnique({ where: { id: oldConcept.id } });
    expect(oldConceptRow).toBeNull();
  });

  it("leaves the target's own mastery row untouched (never overwritten) when the orphan's would collide on the same user", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const course = await prisma.course.create({ data: { userId, title: `Collision course ${suffix}` } });
    const document = await prisma.document.create({
      data: {
        courseId: course.id,
        filename: `f-${suffix}.pdf`,
        originalFilename: `Notes ${suffix}.pdf`,
        mimeType: "application/pdf",
        fileSize: 10,
        type: "pdf",
        storagePath: `collision-fixture/${suffix}.pdf`,
        processingStatus: "READY",
      },
    });
    const chunkA = await prisma.documentChunk.create({ data: { documentId: document.id, text: "Concept A material.", chunkIndex: 0, tokenCount: 4 } });
    const chunkB = await prisma.documentChunk.create({ data: { documentId: document.id, text: "Concept B material.", chunkIndex: 1, tokenCount: 4 } });

    vi.mocked(extractStructured).mockImplementation(async (options) => {
      if (options.requestType === "concept_extraction") {
        return {
          data: {
            concepts: [
              { name: "Concept A", description: "...", difficulty: 2, evidence: [{ chunkId: chunkA.id, text: "a" }] },
              { name: "Concept B", description: "...", difficulty: 2, evidence: [{ chunkId: chunkB.id, text: "b" }] },
            ],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      if (options.requestType === "concept_dedup") return { data: { duplicateGroups: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
      if (options.requestType === "relationship_extraction") return { data: { relationships: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
      if (options.requestType === "prerequisite_analysis") return { data: { prerequisites: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
      throw new Error(`unexpected requestType ${options.requestType}`);
    });
    await buildKnowledgeGraph(course.id, { userId });

    const conceptA = await prisma.concept.findFirstOrThrow({ where: { courseId: course.id, name: "Concept A" } });
    const conceptB = await prisma.concept.findFirstOrThrow({ where: { courseId: course.id, name: "Concept B" } });
    await prisma.studentConceptMastery.create({ data: { userId, conceptId: conceptA.id, overallMastery: 0.2, exposureCount: 1, attemptCount: 1, status: "LEARNING" } });
    const targetMastery = await prisma.studentConceptMastery.create({
      data: { userId, conceptId: conceptB.id, overallMastery: 0.81, exposureCount: 6, attemptCount: 6, successCount: 6, status: "STRONG" },
    });

    // Rebuild: "Concept A" disappears (its material is now folded into "Concept B", which now cites
    // both chunks) — A becomes an orphan whose best chunk-overlap match is B, but B already has this
    // user's mastery row, so A's row must NOT overwrite it.
    vi.mocked(extractStructured).mockImplementation(async (options) => {
      if (options.requestType === "concept_extraction") {
        return {
          data: {
            concepts: [
              { name: "Concept B", description: "...", difficulty: 2, evidence: [{ chunkId: chunkA.id, text: "a" }, { chunkId: chunkB.id, text: "b" }] },
            ],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      if (options.requestType === "concept_dedup") return { data: { duplicateGroups: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
      if (options.requestType === "relationship_extraction") return { data: { relationships: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
      if (options.requestType === "prerequisite_analysis") return { data: { prerequisites: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
      throw new Error(`unexpected requestType ${options.requestType}`);
    });
    await buildKnowledgeGraph(course.id, { userId });

    const stillThere = await prisma.studentConceptMastery.findUnique({ where: { id: targetMastery.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.overallMastery).toBe(0.81);
    expect(stillThere!.conceptId).toBe(conceptB.id);

    const conceptARow = await prisma.concept.findUnique({ where: { id: conceptA.id } });
    expect(conceptARow).toBeNull();
  });

  /**
   * Phase 19 §19.5 regression: `ReviewEvent` and `TutorSessionOutcome` each
   * carry their own denormalized `conceptId` (not just inherited through
   * their parent `ReviewItem`/`TutorSession`, which reassignConceptHistory
   * already handled) and both `onDelete: Cascade` on Concept. Before the
   * fix, a rebuild that merged/renamed a concept correctly moved the parent
   * rows but left these two still pointing at the doomed `fromConceptId`,
   * so deleting the orphan silently cascade-deleted supposedly-immutable
   * review/tutor-outcome history for a concept that was never really gone.
   */
  it("reassigns ReviewEvent.conceptId and TutorSessionOutcome.conceptId (not just their parent rows) so a rebuild never cascade-deletes them", async () => {
    const { course, chunk } = await seedCourseWithChunk(userId, "Transport-layer flow control paces sender to receiver.");
    mockPipeline("Flow Control", chunk.id);
    await buildKnowledgeGraph(course.id, { userId });

    const oldConcept = await prisma.concept.findFirstOrThrow({ where: { courseId: course.id } });

    const attempt = await prisma.learningAttempt.create({
      data: { userId, conceptId: oldConcept.id, activityType: "RECALL", score: 0.9, correctness: 0.9 },
    });
    const reviewItem = await prisma.reviewItem.create({
      data: { userId, courseId: course.id, conceptId: oldConcept.id, status: "REVIEW", nextReviewAt: new Date(Date.now() + 86_400_000) },
    });
    const reviewEvent = await prisma.reviewEvent.create({
      data: { reviewItemId: reviewItem.id, userId, conceptId: oldConcept.id, attemptId: attempt.id, outcome: "GOOD", previousInterval: 1, newInterval: 3 },
    });
    const tutorSession = await prisma.tutorSession.create({
      data: { userId, courseId: course.id, conceptId: oldConcept.id, mode: "SOCRATIC", status: "COMPLETED" },
    });
    const tutorOutcome = await prisma.tutorSessionOutcome.create({
      data: { sessionId: tutorSession.id, conceptId: oldConcept.id, masteryDelta: 0.1 },
    });

    // Rebuild with a re-worded name for the same source chunk — oldConcept becomes an orphan
    // reassigned onto the new concept, then deleted.
    mockPipeline("Flow-Control Windowing", chunk.id);
    await buildKnowledgeGraph(course.id, { userId });

    const newConcept = await prisma.concept.findFirstOrThrow({ where: { courseId: course.id } });
    expect(newConcept.id).not.toBe(oldConcept.id);

    const reviewEventAfter = await prisma.reviewEvent.findUnique({ where: { id: reviewEvent.id } });
    expect(reviewEventAfter).not.toBeNull();
    expect(reviewEventAfter!.conceptId).toBe(newConcept.id);

    const tutorOutcomeAfter = await prisma.tutorSessionOutcome.findUnique({ where: { id: tutorOutcome.id } });
    expect(tutorOutcomeAfter).not.toBeNull();
    expect(tutorOutcomeAfter!.conceptId).toBe(newConcept.id);

    const oldConceptRow = await prisma.concept.findUnique({ where: { id: oldConcept.id } });
    expect(oldConceptRow).toBeNull();
  });
});
