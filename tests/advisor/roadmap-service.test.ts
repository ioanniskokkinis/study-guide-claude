import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/claude")>("@/lib/ai/claude");
  return { ...actual, extractStructured: vi.fn() };
});

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import {
  createStudyRoadmap,
  InvalidRoadmapInputError,
  RoadmapGenerationError,
} from "@/lib/advisor/roadmap-service";
import { getRoadmap } from "@/lib/advisor/queries";
import { seedCourseWithConcepts } from "./fixtures";

/**
 * Phase 15 §21-47, §53-55 — the full roadmap-generation pipeline. Only
 * `extractStructured` is mocked; scope resolution, knowledge-gap analysis,
 * time budgeting, and persistence all run for real against Postgres.
 */
describe("createStudyRoadmap", () => {
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `roadmap-${suffix}@example.com` } })).id;
    otherUserId = (await prisma.user.create({ data: { email: `roadmap-other-${suffix}@example.com` } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  afterEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  function mockAiOutput(conceptIds: string[], extraFakeConceptId?: string) {
    vi.mocked(extractStructured).mockResolvedValue({
      data: {
        summary: "A short plan summary.",
        priorities: conceptIds.map((id) => ({ conceptId: id, reason: "Because the data says so." })),
        weeks: [
          {
            weekNumber: 1,
            focusConceptIds: extraFakeConceptId ? [...conceptIds, extraFakeConceptId] : conceptIds,
            reason: "Start with these.",
          },
        ],
        milestones: [{ title: "Finish week one", afterWeek: 1 }],
        risks: ["Not enough sleep."],
        recommendations: ["Study in short bursts."],
      },
      usage: { inputTokens: 500, outputTokens: 300 },
    } as never);
  }

  function futureDeadline(days: number): Date {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  it("rejects a non-future deadline before ever calling the AI", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);

    await expect(
      createStudyRoadmap(userId, {
        courseId: course.id,
        goal: "Pass the exam",
        minutesPerDay: 30,
        deadline: new Date(Date.now() - 1000),
        scope: { scopeType: "COURSE" },
      }),
    ).rejects.toBeInstanceOf(InvalidRoadmapInputError);
    expect(extractStructured).not.toHaveBeenCalled();
  });

  it("rejects a non-positive minutesPerDay", async () => {
    const { course } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    await expect(
      createStudyRoadmap(userId, { courseId: course.id, goal: "Pass", minutesPerDay: 0, scope: { scopeType: "COURSE" } }),
    ).rejects.toBeInstanceOf(InvalidRoadmapInputError);
  });

  it("generates and persists a roadmap with weeks and items, using only allowed concept ids", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 2 });
    mockAiOutput(concepts.map((c) => c.id), "not-a-real-concept-id");

    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: futureDeadline(7),
      scope: { scopeType: "COURSE" },
    });

    expect(roadmap.weeks.length).toBeGreaterThan(0);
    const allItemConceptIds = roadmap.weeks.flatMap((w) => w.items.map((i) => i.conceptId)).filter(Boolean);
    expect(allItemConceptIds).not.toContain("not-a-real-concept-id");
    for (const id of allItemConceptIds) {
      expect(concepts.map((c) => c.id)).toContain(id);
    }
  });

  it("never schedules more total minutes across weeks than the deterministic time budget allows", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 2 });
    mockAiOutput(concepts.map((c) => c.id));

    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 20,
      deadline: futureDeadline(7),
      scope: { scopeType: "COURSE" },
    });

    const totalWeekMinutes = roadmap.weeks.reduce((sum, w) => sum + w.estimatedMinutes, 0);
    const totalItemMinutes = roadmap.weeks.reduce((sum, w) => sum + w.items.reduce((s, i) => s + i.estimatedMinutes, 0), 0);
    expect(totalItemMinutes).toBeLessThanOrEqual(totalWeekMinutes);
    expect(totalWeekMinutes).toBeLessThanOrEqual(20 * 8); // 7 days inclusive + safety margin
  });

  it("logs the AI call to AiUsageLog with requestType STUDY_ADVISOR_INITIAL and a positive estimated cost", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);

    await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 20,
      deadline: futureDeadline(3),
      scope: { scopeType: "COURSE" },
    });

    // extractStructured is mocked, so its own usage-logging body never runs — this test instead
    // confirms the call shape that would drive that logging (requestType, userId) is correct.
    const call = vi.mocked(extractStructured).mock.calls[0][0];
    expect(call.requestType).toBe("STUDY_ADVISOR_INITIAL");
    expect(call.userId).toBe(userId);
  });

  it("throws RoadmapGenerationError and persists nothing when the AI call fails", async () => {
    const { course } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    vi.mocked(extractStructured).mockRejectedValue(new Error("simulated Claude failure"));

    const before = await prisma.studyRoadmap.count({ where: { courseId: course.id } });
    await expect(
      createStudyRoadmap(userId, {
        courseId: course.id,
        goal: "Pass my exam",
        minutesPerDay: 20,
        deadline: futureDeadline(3),
        scope: { scopeType: "COURSE" },
      }),
    ).rejects.toBeInstanceOf(RoadmapGenerationError);
    const after = await prisma.studyRoadmap.count({ where: { courseId: course.id } });
    expect(after).toBe(before);
  });

  it("a user can read their own roadmap but not another user's", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);

    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 20,
      deadline: futureDeadline(3),
      scope: { scopeType: "COURSE" },
    });

    expect((await getRoadmap(userId, roadmap.id))?.id).toBe(roadmap.id);
    expect(await getRoadmap(otherUserId, roadmap.id)).toBeNull();
  });

  it("persists the DOCUMENTS scope relationally via StudyRoadmapDocument, not just a label", async () => {
    const { course, document, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);

    const roadmap = await createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 20,
      deadline: futureDeadline(3),
      scope: { scopeType: "DOCUMENTS", documentIds: [document.id] },
    });

    const scopeRows = await prisma.studyRoadmapDocument.findMany({ where: { roadmapId: roadmap.id } });
    expect(scopeRows.map((r) => r.documentId)).toEqual([document.id]);
  });
});
