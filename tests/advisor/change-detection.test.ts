import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/claude")>("@/lib/ai/claude");
  return { ...actual, extractStructured: vi.fn() };
});

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import { createStudyRoadmap } from "@/lib/advisor/roadmap-service";
import { checkAdaptationNeeded, RoadmapNotFoundForCheckError } from "@/lib/advisor/change-detection";
import { seedCourseWithConcepts } from "./fixtures";

/** Phase 16 §21-22, §59 — deterministic significant-change detection, never an AI call. */
function mockAiOutput(conceptIds: string[]) {
  vi.mocked(extractStructured).mockResolvedValue({
    data: {
      summary: "Plan summary.",
      priorities: conceptIds.map((id) => ({ conceptId: id, reason: "Grounded reason." })),
      weeks: [{ weekNumber: 1, focusConceptIds: conceptIds, reason: "Week one focus." }],
      milestones: [],
      risks: [],
      recommendations: [],
    },
    usage: { inputTokens: 100, outputTokens: 100 },
  } as never);
}

describe("checkAdaptationNeeded", () => {
  let userId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `change-detect-${suffix}@example.com` } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  afterEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  it("throws RoadmapNotFoundForCheckError for a nonexistent roadmap", async () => {
    await expect(checkAdaptationNeeded(userId, "does-not-exist")).rejects.toBeInstanceOf(RoadmapNotFoundForCheckError);
  });

  it("reports no adaptation needed for a freshly generated roadmap with no new evidence", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    const result = await checkAdaptationNeeded(userId, roadmap.id);
    expect(result).toEqual({ needed: false, triggers: [], details: [] });
  });

  it("flags MISSED_SESSIONS when enough sessions have been missed", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 2 });
    mockAiOutput(concepts.map((c) => c.id));
    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    const items = await prisma.studyRoadmapItem.findMany({ where: { roadmapId: roadmap.id, isMilestone: false } });
    await prisma.studyRoadmapItem.update({ where: { id: items[0].id }, data: { scheduledDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } });
    await prisma.studyRoadmapItem.update({ where: { id: items[1].id }, data: { scheduledDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) } });

    const result = await checkAdaptationNeeded(userId, roadmap.id);
    expect(result.needed).toBe(true);
    expect(result.triggers).toContain("MISSED_SESSIONS");
  });

  it("flags KNOWLEDGE_CHANGE when enough new evidence has accumulated since the roadmap was last evaluated", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    await prisma.knowledgeEvidence.createMany({
      data: Array.from({ length: 5 }, () => ({
        userId,
        conceptId: concepts[0].id,
        sourceType: "QUESTION" as const,
        outcome: "SUCCESS" as const,
        score: 0.6,
      })),
    });

    const result = await checkAdaptationNeeded(userId, roadmap.id);
    expect(result.needed).toBe(true);
    expect(result.triggers).toContain("KNOWLEDGE_CHANGE");
  });

  it("flags KNOWLEDGE_CHANGE when a scoped concept's mastery has swung meaningfully since baseline", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    // Baseline mastery for a never-attempted concept is 0 — move it well past the significant-swing threshold.
    await prisma.studentConceptMastery.create({
      data: { userId, conceptId: concepts[0].id, overallMastery: 0.6, exposureCount: 3, status: "DEVELOPING" },
    });

    const result = await checkAdaptationNeeded(userId, roadmap.id);
    expect(result.needed).toBe(true);
    expect(result.triggers).toContain("KNOWLEDGE_CHANGE");
  });

  it("flags LOW_PERFORMANCE when a scoped concept's recent trend is declining", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    const scores = [0.9, 0.9, 0.9, 0.2, 0.2];
    for (const score of scores) {
      await prisma.knowledgeEvidence.create({
        data: { userId, conceptId: concepts[0].id, sourceType: "QUESTION", outcome: score >= 0.5 ? "SUCCESS" : "FAILURE", score },
      });
    }

    const result = await checkAdaptationNeeded(userId, roadmap.id);
    expect(result.needed).toBe(true);
    expect(result.triggers).toContain("LOW_PERFORMANCE");
  });

  it("never flags adaptation needed for a PAUSED roadmap, even with missed sessions and new evidence", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 2 });
    mockAiOutput(concepts.map((c) => c.id));
    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });
    await prisma.studyRoadmapItem.updateMany({
      where: { roadmapId: roadmap.id, isMilestone: false },
      data: { scheduledDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
    });
    await prisma.studyRoadmap.update({ where: { id: roadmap.id }, data: { status: "PAUSED" } });

    const result = await checkAdaptationNeeded(userId, roadmap.id);
    expect(result).toEqual({ needed: false, triggers: [], details: [] });
  });

  it("never calls the AI while checking for adaptation", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });
    vi.mocked(extractStructured).mockClear();

    await checkAdaptationNeeded(userId, roadmap.id);
    expect(extractStructured).not.toHaveBeenCalled();
  });
});
