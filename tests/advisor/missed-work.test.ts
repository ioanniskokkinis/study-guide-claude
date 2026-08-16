import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/claude")>("@/lib/ai/claude");
  return { ...actual, extractStructured: vi.fn() };
});

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import { createStudyRoadmap } from "@/lib/advisor/roadmap-service";
import { getMissedWorkSummary } from "@/lib/advisor/missed-work";
import { seedCourseWithConcepts } from "./fixtures";

/** Phase 16 §7-8, §58 — deterministic missed-session detection, and the PAUSED exemption from spec §32. */
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

describe("getMissedWorkSummary", () => {
  let userId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `missed-work-${suffix}@example.com` } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  afterEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  async function seedRoadmap(minutesPerDay = 30) {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 2 });
    mockAiOutput(concepts.map((c) => c.id));
    return createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay,
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });
  }

  it("returns null for a roadmap that doesn't exist or isn't owned by this user", async () => {
    expect(await getMissedWorkSummary(userId, "does-not-exist")).toBeNull();
  });

  it("reports zero missed work when every item is scheduled in the future", async () => {
    const roadmap = await seedRoadmap();
    await prisma.studyRoadmapItem.updateMany({
      where: { roadmapId: roadmap.id, isMilestone: false },
      data: { scheduledDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) },
    });
    const summary = await getMissedWorkSummary(userId, roadmap.id);
    expect(summary).toEqual({ missedMinutes: 0, missedSessionsCount: 0, overdueItemCount: 0 });
  });

  it("counts overdue PENDING items as missed minutes and sessions", async () => {
    const roadmap = await seedRoadmap();
    await prisma.studyRoadmapItem.updateMany({
      where: { roadmapId: roadmap.id, isMilestone: false },
      data: { scheduledDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
    });

    const summary = await getMissedWorkSummary(userId, roadmap.id);
    expect(summary!.overdueItemCount).toBeGreaterThan(0);
    expect(summary!.missedMinutes).toBeGreaterThan(0);
    expect(summary!.missedSessionsCount).toBeGreaterThan(0);
  });

  it("groups missed items on the same calendar date into a single missed session", async () => {
    const roadmap = await seedRoadmap();
    const sameDay = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.studyRoadmapItem.updateMany({
      where: { roadmapId: roadmap.id, isMilestone: false },
      data: { scheduledDate: sameDay },
    });

    const summary = await getMissedWorkSummary(userId, roadmap.id);
    expect(summary!.missedSessionsCount).toBe(1);
  });

  it("never accrues missed-work penalties for a paused roadmap", async () => {
    const roadmap = await seedRoadmap();
    await prisma.studyRoadmapItem.updateMany({
      where: { roadmapId: roadmap.id, isMilestone: false },
      data: { scheduledDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) },
    });
    await prisma.studyRoadmap.update({ where: { id: roadmap.id }, data: { status: "PAUSED" } });

    const summary = await getMissedWorkSummary(userId, roadmap.id);
    expect(summary).toEqual({ missedMinutes: 0, missedSessionsCount: 0, overdueItemCount: 0 });
  });

  it("does not count items that are already COMPLETED as missed, even if their date passed", async () => {
    const roadmap = await seedRoadmap();
    const item = roadmap.weeks.flatMap((w) => w.items).find((i) => !i.isMilestone)!;

    // Every other item is pushed into the future first so only the COMPLETED item below has a
    // past scheduledDate — otherwise an unrelated item that happens to land on "today" would
    // already read as overdue (its scheduledDate is midnight, compared against the current instant).
    await prisma.studyRoadmapItem.updateMany({
      where: { roadmapId: roadmap.id, isMilestone: false, id: { not: item.id } },
      data: { scheduledDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) },
    });
    await prisma.studyRoadmapItem.update({
      where: { id: item.id },
      data: { status: "COMPLETED", scheduledDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
    });

    const summary = await getMissedWorkSummary(userId, roadmap.id);
    expect(summary!.overdueItemCount).toBe(0);
  });
});
