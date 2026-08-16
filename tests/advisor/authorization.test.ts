import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/claude")>("@/lib/ai/claude");
  return { ...actual, extractStructured: vi.fn() };
});

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import { createStudyRoadmap } from "@/lib/advisor/roadmap-service";
import { getRoadmapHealthForRoadmap } from "@/lib/advisor/health";
import { getNextBestAction } from "@/lib/advisor/next-action";
import { checkAdaptationNeeded, RoadmapNotFoundForCheckError } from "@/lib/advisor/change-detection";
import { getMissedWorkSummary } from "@/lib/advisor/missed-work";
import { getRoadmapUrgency } from "@/lib/advisor/urgency";
import { pauseRoadmap, RoadmapNotFoundError } from "@/lib/advisor/lifecycle";
import { replanStudyRoadmap, RoadmapNotFoundError as ReplanRoadmapNotFoundError } from "@/lib/advisor/replan";
import { seedCourseWithConcepts } from "./fixtures";

/**
 * Phase 16 §53-54, §64 — every Advisor operation enforces ownership
 * server-side, never relying on frontend filtering. All of these functions
 * take `userId` and scope every query by it, so a second user's id should
 * never be able to read, replan, pause, or otherwise act on the first
 * user's roadmap.
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

describe("Phase 16 Advisor authorization", () => {
  let ownerId: string;
  let attackerId: string;
  let roadmapId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    ownerId = (await prisma.user.create({ data: { email: `authz-owner-${suffix}@example.com` } })).id;
    attackerId = (await prisma.user.create({ data: { email: `authz-attacker-${suffix}@example.com` } })).id;

    const { course, concepts } = await seedCourseWithConcepts(ownerId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const roadmap = await createStudyRoadmap(ownerId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });
    roadmapId = roadmap.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, attackerId] } } });
  });

  afterEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  it("returns the roadmap's health for the owner but null for another user", async () => {
    expect(await getRoadmapHealthForRoadmap(ownerId, roadmapId)).not.toBeNull();
    expect(await getRoadmapHealthForRoadmap(attackerId, roadmapId)).toBeNull();
  });

  it("returns a next-best-action for the owner but null for another user", async () => {
    expect(await getNextBestAction(ownerId, roadmapId)).not.toBeNull();
    expect(await getNextBestAction(attackerId, roadmapId)).toBeNull();
  });

  it("checks adaptation for the owner but rejects another user with RoadmapNotFoundForCheckError", async () => {
    await expect(checkAdaptationNeeded(ownerId, roadmapId)).resolves.toBeDefined();
    await expect(checkAdaptationNeeded(attackerId, roadmapId)).rejects.toBeInstanceOf(RoadmapNotFoundForCheckError);
  });

  it("returns missed-work data for the owner but null for another user", async () => {
    expect(await getMissedWorkSummary(ownerId, roadmapId)).not.toBeNull();
    expect(await getMissedWorkSummary(attackerId, roadmapId)).toBeNull();
  });

  it("returns urgency data for the owner but null for another user", async () => {
    expect(await getRoadmapUrgency(ownerId, roadmapId)).not.toBeNull();
    expect(await getRoadmapUrgency(attackerId, roadmapId)).toBeNull();
  });

  it("rejects another user pausing the owner's roadmap, and the roadmap stays untouched", async () => {
    await expect(pauseRoadmap(attackerId, roadmapId)).rejects.toBeInstanceOf(RoadmapNotFoundError);
    const row = await prisma.studyRoadmap.findUniqueOrThrow({ where: { id: roadmapId } });
    expect(row.status).toBe("ACTIVE");
  });

  it("rejects another user replanning the owner's roadmap", async () => {
    await expect(replanStudyRoadmap(attackerId, roadmapId)).rejects.toBeInstanceOf(ReplanRoadmapNotFoundError);
    expect(extractStructured).not.toHaveBeenCalled();
  });
});
