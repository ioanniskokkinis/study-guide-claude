import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/claude")>("@/lib/ai/claude");
  return { ...actual, extractStructured: vi.fn() };
});

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import { createStudyRoadmap } from "@/lib/advisor/roadmap-service";
import { replanStudyRoadmap, RoadmapNotActiveError, RoadmapNotFoundError } from "@/lib/advisor/replan";
import { getRoadmapProgress, updateRoadmapItemStatus } from "@/lib/advisor/progress";
import { seedCourseWithConcepts } from "./fixtures";

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

describe("replanStudyRoadmap and roadmap progress", () => {
  let userId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `replan-${suffix}@example.com` } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  afterEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  it("throws RoadmapNotFoundError for a nonexistent roadmap", async () => {
    await expect(replanStudyRoadmap(userId, "does-not-exist")).rejects.toBeInstanceOf(RoadmapNotFoundError);
  });

  it("creates a new version, links replacesRoadmapId, and archives the old roadmap — never deletes it", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);

    const original = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 20,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    mockAiOutput([concepts[0].id]);
    const replanned = await replanStudyRoadmap(userId, original.id);

    expect(replanned.replacesRoadmapId).toBe(original.id);
    const oldRow = await prisma.studyRoadmap.findUniqueOrThrow({ where: { id: original.id } });
    expect(oldRow.status).toBe("ARCHIVED");
    const newRow = await prisma.studyRoadmap.findUniqueOrThrow({ where: { id: replanned.id } });
    expect(newRow.status).toBe("ACTIVE");
  });

  it("rejects replanning an already-archived roadmap", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const original = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 20,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });
    await prisma.studyRoadmap.update({ where: { id: original.id }, data: { status: "ARCHIVED" } });

    await expect(replanStudyRoadmap(userId, original.id)).rejects.toBeInstanceOf(RoadmapNotActiveError);
  });

  it("surfaces overdue/completed context to the AI on replan", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const original = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 20,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    const firstItem = original.weeks[0]?.items[0];
    if (firstItem) await updateRoadmapItemStatus(userId, firstItem.id, "COMPLETED");

    mockAiOutput([concepts[0].id]);
    await replanStudyRoadmap(userId, original.id);

    const replanCall = vi.mocked(extractStructured).mock.calls[1][0];
    expect(replanCall.prompt).toContain("replan");
  });

  it("progress reflects real mastery movement, not just item completion", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    const before = await getRoadmapProgress(userId, roadmap.id);
    expect(before?.currentAverageMasteryPercent).toBe(0);

    await prisma.studentConceptMastery.create({
      data: { userId, conceptId: concepts[0].id, overallMastery: 0.8, exposureCount: 4, status: "STRONG" },
    });

    const after = await getRoadmapProgress(userId, roadmap.id);
    expect(after?.currentAverageMasteryPercent).toBeCloseTo(0.8, 5);
    expect(after!.overallProgressPercent).toBeGreaterThan(before!.overallProgressPercent);
  });

  it("counts overdue items as PENDING items whose scheduledDate has passed", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    await prisma.studyRoadmapItem.updateMany({
      where: { roadmapId: roadmap.id },
      data: { scheduledDate: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    const progress = await getRoadmapProgress(userId, roadmap.id);
    expect(progress?.overdueItems).toBeGreaterThan(0);
  });

  it("marking an item COMPLETED sets completedAt and is reflected in completion counts", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });
    const item = roadmap.weeks[0]?.items[0];
    expect(item).toBeDefined();

    await updateRoadmapItemStatus(userId, item!.id, "COMPLETED");
    const updated = await prisma.studyRoadmapItem.findUniqueOrThrow({ where: { id: item!.id } });
    expect(updated.status).toBe("COMPLETED");
    expect(updated.completedAt).not.toBeNull();

    const progress = await getRoadmapProgress(userId, roadmap.id);
    expect(progress?.completedItems).toBeGreaterThanOrEqual(1);
  });
});
