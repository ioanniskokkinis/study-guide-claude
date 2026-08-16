import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/claude")>("@/lib/ai/claude");
  return { ...actual, extractStructured: vi.fn() };
});

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import { createStudyRoadmap } from "@/lib/advisor/roadmap-service";
import { pauseRoadmap, resumeRoadmap, RoadmapNotFoundError, RoadmapNotPausedError, RoadmapNotResumableError } from "@/lib/advisor/lifecycle";
import { seedCourseWithConcepts } from "./fixtures";

/** Phase 16 §32, §58 — pause/resume, never auto-replanning, never accruing penalties while paused. */
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

describe("pauseRoadmap / resumeRoadmap", () => {
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `lifecycle-${suffix}@example.com` } })).id;
    otherUserId = (await prisma.user.create({ data: { email: `lifecycle-other-${suffix}@example.com` } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  afterEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  async function seedRoadmap() {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    return createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });
  }

  it("throws RoadmapNotFoundError pausing a nonexistent roadmap", async () => {
    await expect(pauseRoadmap(userId, "does-not-exist")).rejects.toBeInstanceOf(RoadmapNotFoundError);
  });

  it("throws RoadmapNotFoundError pausing another user's roadmap", async () => {
    const roadmap = await seedRoadmap();
    await expect(pauseRoadmap(otherUserId, roadmap.id)).rejects.toBeInstanceOf(RoadmapNotFoundError);
    const unchanged = await prisma.studyRoadmap.findUniqueOrThrow({ where: { id: roadmap.id } });
    expect(unchanged.status).toBe("ACTIVE");
  });

  it("pauses an ACTIVE roadmap", async () => {
    const roadmap = await seedRoadmap();
    const paused = await pauseRoadmap(userId, roadmap.id);
    expect(paused.status).toBe("PAUSED");
  });

  it("rejects pausing a roadmap that isn't ACTIVE", async () => {
    const roadmap = await seedRoadmap();
    await pauseRoadmap(userId, roadmap.id);
    await expect(pauseRoadmap(userId, roadmap.id)).rejects.toBeInstanceOf(RoadmapNotResumableError);
  });

  it("rejects resuming a roadmap that isn't PAUSED", async () => {
    const roadmap = await seedRoadmap();
    await expect(resumeRoadmap(userId, roadmap.id)).rejects.toBeInstanceOf(RoadmapNotPausedError);
  });

  it("resumes a PAUSED roadmap back to ACTIVE without ever calling the AI", async () => {
    const roadmap = await seedRoadmap();
    await pauseRoadmap(userId, roadmap.id);
    vi.mocked(extractStructured).mockClear();

    const result = await resumeRoadmap(userId, roadmap.id);
    expect(result.status).toBe("ACTIVE");
    expect(extractStructured).not.toHaveBeenCalled();

    const row = await prisma.studyRoadmap.findUniqueOrThrow({ where: { id: roadmap.id } });
    expect(row.status).toBe("ACTIVE");
  });

  it("resume surfaces a suggested adaptation but never applies one automatically", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 2 });
    mockAiOutput(concepts.map((c) => c.id));
    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    await pauseRoadmap(userId, roadmap.id);
    // Missed sessions accrued before pausing (backdated), so once resumed there's a real signal to surface.
    const items = await prisma.studyRoadmapItem.findMany({ where: { roadmapId: roadmap.id, isMilestone: false } });
    await prisma.studyRoadmapItem.update({ where: { id: items[0].id }, data: { scheduledDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } });
    await prisma.studyRoadmapItem.update({ where: { id: items[1].id }, data: { scheduledDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) } });

    const result = await resumeRoadmap(userId, roadmap.id);
    expect(result.suggestedAdaptation.needed).toBe(true);
    expect(result.suggestedAdaptation.triggers).toContain("MISSED_SESSIONS");

    // The version is unchanged — resume never regenerates or mutates the plan itself.
    const row = await prisma.studyRoadmap.findUniqueOrThrow({ where: { id: roadmap.id } });
    expect(row.version).toBe(1);
  });
});
