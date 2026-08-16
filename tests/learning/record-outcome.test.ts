import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { recordLearningOutcome } from "@/lib/learning/record-outcome";
import { resolveMistake } from "@/lib/services/student-knowledge";

describe("recordLearningOutcome", () => {
  let userId: string;
  let otherUserId: string;
  let conceptId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-outcome-${suffix}@example.com` } });
    userId = user.id;
    const otherUser = await prisma.user.create({ data: { email: `test-outcome-other-${suffix}@example.com` } });
    otherUserId = otherUser.id;

    const course = await prisma.course.create({ data: { userId, title: "Networking" } });
    const concept = await prisma.concept.create({
      data: { courseId: course.id, name: "Firewalls", normalizedName: "firewalls" },
    });
    conceptId = concept.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  it("returns null when the concept isn't owned by the user (never accepts an arbitrary userId)", async () => {
    const result = await recordLearningOutcome({
      userId: otherUserId,
      conceptId,
      activityType: "RECALL",
      score: 0.8,
    });
    expect(result).toBeNull();
  });

  it("creates exactly one attempt, one evidence record, and one mastery row per call (idempotency/integrity)", async () => {
    const before = await Promise.all([
      prisma.learningAttempt.count({ where: { userId, conceptId } }),
      prisma.knowledgeEvidence.count({ where: { userId, conceptId } }),
    ]);

    const result = await recordLearningOutcome({
      userId,
      conceptId,
      activityType: "RECALL",
      score: 0.9,
      confidence: 0.8,
    });

    expect(result).not.toBeNull();
    expect(result!.attempt.id).toBeTruthy();
    expect(result!.evidence.id).toBeTruthy();
    expect(result!.mastery.userId).toBe(userId);

    const after = await Promise.all([
      prisma.learningAttempt.count({ where: { userId, conceptId } }),
      prisma.knowledgeEvidence.count({ where: { userId, conceptId } }),
      prisma.studentConceptMastery.count({ where: { userId, conceptId } }),
    ]);

    expect(after[0]).toBe(before[0] + 1);
    expect(after[1]).toBe(before[1] + 1);
    expect(after[2]).toBe(1); // lazily created exactly once, never duplicated
  });

  it("never overwrites previous attempts — repeated calls grow the history", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-history-${suffix}@example.com` } });
    const course = await prisma.course.create({ data: { userId: user.id, title: "History course" } });
    const concept = await prisma.concept.create({
      data: { courseId: course.id, name: "Ports", normalizedName: "ports" },
    });

    for (let i = 0; i < 3; i++) {
      await recordLearningOutcome({ userId: user.id, conceptId: concept.id, activityType: "RECALL", score: 0.6 });
    }

    const attempts = await prisma.learningAttempt.count({ where: { userId: user.id, conceptId: concept.id } });
    const evidence = await prisma.knowledgeEvidence.count({ where: { userId: user.id, conceptId: concept.id } });
    expect(attempts).toBe(3);
    expect(evidence).toBe(3);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it("creates a StudentMistake per pre-classified mistake, distinguishing misconception from knowledge gap", async () => {
    const result = await recordLearningOutcome({
      userId,
      conceptId,
      activityType: "APPLICATION",
      score: 0.2,
      mistakes: [
        { category: "MISCONCEPTION", description: "Believes firewalls block all traffic by default." },
        { category: "CONCEPTUAL_GAP", description: "Doesn't yet know what stateful inspection means." },
      ],
    });

    expect(result!.mistakes).toHaveLength(2);
    const categories = result!.mistakes.map((m) => m.category).sort();
    expect(categories).toEqual(["CONCEPTUAL_GAP", "MISCONCEPTION"]);
    expect(result!.mistakes.every((m) => m.attemptId === result!.attempt.id)).toBe(true);
  });

  it("resolving a mistake does not change mastery, and never deletes the row (spec §23-24)", async () => {
    const outcome = await recordLearningOutcome({
      userId,
      conceptId,
      activityType: "RECALL",
      score: 0.3,
      mistakes: [{ category: "FACTUAL_ERROR", description: "Mixed up TCP and UDP." }],
    });
    const mistakeId = outcome!.mistakes[0].id;

    const masteryBefore = await prisma.studentConceptMastery.findUnique({
      where: { userId_conceptId: { userId, conceptId } },
    });

    const resolved = await resolveMistake(userId, mistakeId);
    expect(resolved).not.toBeNull();
    expect(resolved!.resolved).toBe(true);
    expect(resolved!.resolvedAt).not.toBeNull();

    const masteryAfter = await prisma.studentConceptMastery.findUnique({
      where: { userId_conceptId: { userId, conceptId } },
    });
    expect(masteryAfter!.overallMastery).toBe(masteryBefore!.overallMastery);
    expect(masteryAfter!.updatedAt.getTime()).toBe(masteryBefore!.updatedAt.getTime());

    const stillExists = await prisma.studentMistake.findUnique({ where: { id: mistakeId } });
    expect(stillExists).not.toBeNull();
  });

  it("resolveMistake returns null for a mistake not owned by the caller", async () => {
    const outcome = await recordLearningOutcome({
      userId,
      conceptId,
      activityType: "RECALL",
      score: 0.3,
      mistakes: [{ category: "CARELESS_ERROR", description: "Typo in the answer." }],
    });
    const mistakeId = outcome!.mistakes[0].id;

    expect(await resolveMistake(otherUserId, mistakeId)).toBeNull();
  });

  it("persists currentStreak/bestStreak across calls, resetting current but never bestStreak on a losing turn", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-streak-${suffix}@example.com` } });
    const course = await prisma.course.create({ data: { userId: user.id, title: "Streak course" } });
    const concept = await prisma.concept.create({
      data: { courseId: course.id, name: "VLANs", normalizedName: "vlans" },
    });

    const first = await recordLearningOutcome({
      userId: user.id,
      conceptId: concept.id,
      activityType: "RECALL",
      score: 0.5,
      outcome: "SUCCESS",
      difficulty: 1,
    });
    const second = await recordLearningOutcome({
      userId: user.id,
      conceptId: concept.id,
      activityType: "RECALL",
      score: 1,
      outcome: "SUCCESS",
      difficulty: 5,
    });

    expect(first!.mastery.currentStreak).toBe(1);
    expect(second!.mastery.currentStreak).toBe(2);
    expect(second!.mastery.bestStreak).toBe(2);

    const failure = await recordLearningOutcome({
      userId: user.id,
      conceptId: concept.id,
      activityType: "RECALL",
      score: 0,
      outcome: "FAILURE",
      difficulty: 3,
    });
    expect(failure!.mastery.currentStreak).toBe(-1);
    expect(failure!.mastery.bestStreak).toBe(2); // never decreases

    await prisma.user.delete({ where: { id: user.id } });
  });

  it("threads difficulty through to the mastery update: a harder-question success moves the score further than an equally-positioned easier one", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-difficulty-${suffix}@example.com` } });
    const course = await prisma.course.create({ data: { userId: user.id, title: "Difficulty course" } });
    const easyConcept = await prisma.concept.create({
      data: { courseId: course.id, name: "Easy Concept", normalizedName: "easy-concept" },
    });
    const hardConcept = await prisma.concept.create({
      data: { courseId: course.id, name: "Hard Concept", normalizedName: "hard-concept" },
    });

    // Establish an identical non-zero, non-one baseline on each concept (first touch takes the score outright).
    await recordLearningOutcome({ userId: user.id, conceptId: easyConcept.id, activityType: "RECALL", score: 0.5, outcome: "SUCCESS" });
    await recordLearningOutcome({ userId: user.id, conceptId: hardConcept.id, activityType: "RECALL", score: 0.5, outcome: "SUCCESS" });

    const easyResult = await recordLearningOutcome({
      userId: user.id,
      conceptId: easyConcept.id,
      activityType: "RECALL",
      score: 1,
      outcome: "SUCCESS",
      difficulty: 1,
    });
    const hardResult = await recordLearningOutcome({
      userId: user.id,
      conceptId: hardConcept.id,
      activityType: "RECALL",
      score: 1,
      outcome: "SUCCESS",
      difficulty: 5,
    });

    expect(hardResult!.mastery.recallScore).toBeGreaterThan(easyResult!.mastery.recallScore);

    await prisma.user.delete({ where: { id: user.id } });
  });
});
