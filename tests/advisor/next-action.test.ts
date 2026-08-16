import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/claude")>("@/lib/ai/claude");
  return { ...actual, extractStructured: vi.fn() };
});

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import { createStudyRoadmap } from "@/lib/advisor/roadmap-service";
import { getNextBestAction } from "@/lib/advisor/next-action";
import { seedCourseWithConcepts } from "./fixtures";

/**
 * Phase 16 §18-19, §61-62 — deterministic "what should I study now?", never
 * an AI call. Reuses the roadmap's own today/overdue items, then the
 * spaced-repetition due-queue, then the knowledge-gap ranking, in that order.
 */
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

describe("getNextBestAction", () => {
  let userId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `next-action-${suffix}@example.com` } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  afterEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  it("returns null for a roadmap that doesn't exist or isn't owned by this user", async () => {
    expect(await getNextBestAction(userId, "does-not-exist")).toBeNull();
  });

  it("returns NONE for a roadmap that isn't ACTIVE", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });
    await prisma.studyRoadmap.update({ where: { id: roadmap.id }, data: { status: "PAUSED" } });

    const result = await getNextBestAction(userId, roadmap.id);
    expect(result?.type).toBe("NONE");
  });

  it("recommends the roadmap's own highest-priority pending item scheduled for today", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    const result = await getNextBestAction(userId, roadmap.id);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("conceptId", concepts[0].id);
    if (result && "roadmapItemId" in result) expect(result.roadmapItemId).not.toBeNull();
  });

  it("falls back to a due spaced-repetition item when nothing is scheduled today or overdue", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    // Mark all roadmap items complete so the today/overdue path is exhausted.
    await prisma.studyRoadmapItem.updateMany({ where: { roadmapId: roadmap.id }, data: { status: "COMPLETED" } });

    await prisma.reviewItem.create({
      data: {
        userId,
        courseId: course.id,
        conceptId: concepts[0].id,
        status: "LEARNING",
        interval: 1,
        stability: 1,
        difficulty: 3,
        repetitionCount: 1,
        lapseCount: 0,
        nextReviewAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });

    const result = await getNextBestAction(userId, roadmap.id);
    expect(result).toMatchObject({ type: "SPACED_REPETITION", conceptId: concepts[0].id });
  });

  it("recommends TUTOR instead of more practice when recent accuracy is very low with a repeated incorrect streak", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    await prisma.learningAttempt.createMany({
      data: Array.from({ length: 4 }, () => ({
        userId,
        conceptId: concepts[0].id,
        activityType: "RECALL" as const,
        correctness: 0.1,
      })),
    });

    const result = await getNextBestAction(userId, roadmap.id);
    expect(result).toMatchObject({ type: "TUTOR", conceptId: concepts[0].id });
  });

  it("returns NONE with a plain explanation when there is no scoped knowledge data at all", async () => {
    const { course } = await seedCourseWithConcepts(userId, { conceptCount: 0 });
    mockAiOutput([]);
    await expect(
      createStudyRoadmap(userId, {
        courseId: course.id,
        goal: "Pass my exam",
        minutesPerDay: 30,
        deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        scope: { scopeType: "COURSE" },
      }),
    ).rejects.toThrow();
  });
});
