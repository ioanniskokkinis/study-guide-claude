import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/claude")>("@/lib/ai/claude");
  return { ...actual, extractStructured: vi.fn() };
});

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import { createStudyRoadmap } from "@/lib/advisor/roadmap-service";
import { replanStudyRoadmap } from "@/lib/advisor/replan";
import { updateRoadmapItemStatus } from "@/lib/advisor/progress";
import { seedCourseWithConcepts } from "./fixtures";

/** Phase 16 §3, §26-27, §59 — roadmap versioning: increasing version numbers, preserved history, carried-forward completed work, and a deterministic change diff. */
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

describe("roadmap versioning", () => {
  let userId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `versioning-${suffix}@example.com` } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  afterEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  it("starts a freshly generated roadmap at version 1", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);

    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 20,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    expect(roadmap.version).toBe(1);
  });

  it("increments the version number by one on each replan, and each replan records its own trigger and reason", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const v1 = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 20,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });
    expect(v1.adaptationTrigger).toBe("INITIAL_GENERATION");

    mockAiOutput([concepts[0].id]);
    const v2 = await replanStudyRoadmap(userId, v1.id, { trigger: "LOW_PERFORMANCE" });
    expect(v2.version).toBe(2);
    expect(v2.adaptationTrigger).toBe("LOW_PERFORMANCE");
    expect(v2.adaptationReason).toBeTruthy();

    mockAiOutput([concepts[0].id]);
    const v3 = await replanStudyRoadmap(userId, v2.id, { trigger: "MANUAL_REPLAN" });
    expect(v3.version).toBe(3);
  });

  it("keeps every previous version accessible (never deletes) — old rows remain queryable by id", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const v1 = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 20,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });
    mockAiOutput([concepts[0].id]);
    const v2 = await replanStudyRoadmap(userId, v1.id);

    const oldRow = await prisma.studyRoadmap.findUniqueOrThrow({ where: { id: v1.id } });
    expect(oldRow.status).toBe("ARCHIVED");
    expect(v2.replacesRoadmapId).toBe(v1.id);
  });

  it("carries forward completed items into the new version instead of losing them", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 2 });
    mockAiOutput(concepts.map((c) => c.id));
    const v1 = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 40,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    const firstItem = v1.weeks.flatMap((w) => w.items).find((i) => !i.isMilestone);
    expect(firstItem).toBeDefined();
    await updateRoadmapItemStatus(userId, firstItem!.id, "COMPLETED");

    mockAiOutput(concepts.map((c) => c.id));
    const v2 = await replanStudyRoadmap(userId, v1.id);

    const carried = v2.weeks.flatMap((w) => w.items).filter((i) => i.carriedForward);
    const carriedInDb = await prisma.studyRoadmapItem.findMany({ where: { roadmapId: v2.id, carriedForward: true } });
    expect(carriedInDb.length).toBeGreaterThanOrEqual(1);
    expect(carriedInDb.every((i) => i.status === "COMPLETED" && i.weekId === null)).toBe(true);
    expect(carried).toBeDefined();
  });

  it("produces a changeSummary diff on replan, and leaves it null on the initial version", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const v1 = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 20,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });
    expect(v1.changeSummary).toBeNull();

    mockAiOutput([concepts[0].id]);
    const v2 = await replanStudyRoadmap(userId, v1.id);
    expect(v2.changeSummary).not.toBeNull();
    expect(v2.changeSummary).toHaveProperty("removed");
    expect(v2.changeSummary).toHaveProperty("movedEarlier");
    expect(v2.changeSummary).toHaveProperty("added");
  });

  it("a deadline change replans with trigger DEADLINE_CHANGE and applies the new deadline", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const v1 = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 20,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    const newDeadline = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);
    mockAiOutput([concepts[0].id]);
    const v2 = await replanStudyRoadmap(userId, v1.id, { trigger: "DEADLINE_CHANGE", deadline: newDeadline });

    expect(v2.adaptationTrigger).toBe("DEADLINE_CHANGE");
    expect(v2.deadline?.getTime()).toBe(newDeadline.getTime());
  });

  it("omitting deadline from replan options keeps the roadmap's current deadline unchanged", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    const originalDeadline = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    mockAiOutput([concepts[0].id]);
    const v1 = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 20,
      deadline: originalDeadline,
      scope: { scopeType: "COURSE" },
    });

    mockAiOutput([concepts[0].id]);
    const v2 = await replanStudyRoadmap(userId, v1.id, { trigger: "TIME_AVAILABILITY_CHANGE", minutesPerDay: 45 });

    expect(v2.deadline?.getTime()).toBe(originalDeadline.getTime());
    expect(v2.minutesPerDay).toBe(45);
  });
});
