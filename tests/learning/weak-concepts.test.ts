import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { rankWeakConcepts } from "@/lib/learning/weak-concepts";

describe("rankWeakConcepts", () => {
  let userId: string;
  let otherUserId: string;
  let courseId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-weak-${suffix}@example.com` } });
    userId = user.id;
    const otherUser = await prisma.user.create({ data: { email: `test-weak-other-${suffix}@example.com` } });
    otherUserId = otherUser.id;

    const course = await prisma.course.create({ data: { userId, title: "Weak concepts course" } });
    courseId = course.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  it("returns null for a course not owned by the caller", async () => {
    expect(await rankWeakConcepts(otherUserId, courseId)).toBeNull();
  });

  it("returns an empty array for a course with no concepts yet", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const empty = await prisma.course.create({ data: { userId, title: `Empty ${suffix}` } });
    expect(await rankWeakConcepts(userId, empty.id)).toEqual([]);
  });

  it("returns an empty array for a brand-new student with no learning history (nothing weak, since nothing is evidenced)", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const course = await prisma.course.create({ data: { userId, title: `No history ${suffix}` } });
    await prisma.concept.create({ data: { courseId: course.id, name: "Untouched", normalizedName: "untouched" } });
    expect(await rankWeakConcepts(userId, course.id)).toEqual([]);
  });

  it("excludes strong/mastered/unknown concepts and only ranks the weak bucket", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const course = await prisma.course.create({ data: { userId, title: `Buckets ${suffix}` } });
    const weak = await prisma.concept.create({ data: { courseId: course.id, name: "Weak One", normalizedName: "weak-one" } });
    const strong = await prisma.concept.create({ data: { courseId: course.id, name: "Strong One", normalizedName: "strong-one" } });
    await prisma.concept.create({ data: { courseId: course.id, name: "Never Attempted", normalizedName: "never-attempted" } });

    await prisma.studentConceptMastery.create({
      data: { userId, conceptId: weak.id, overallMastery: 0.2, exposureCount: 2, attemptCount: 2, status: "LEARNING" },
    });
    await prisma.studentConceptMastery.create({
      data: { userId, conceptId: strong.id, overallMastery: 0.9, exposureCount: 5, attemptCount: 5, successCount: 5, status: "MASTERED" },
    });

    const ranked = await rankWeakConcepts(userId, course.id);
    expect(ranked).toHaveLength(1);
    expect(ranked![0].conceptId).toBe(weak.id);
  });

  it("ranks a lower-mastery concept above a higher-mastery one, all else equal", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const course = await prisma.course.create({ data: { userId, title: `Mastery gap ${suffix}` } });
    const veryWeak = await prisma.concept.create({ data: { courseId: course.id, name: "Very Weak", normalizedName: "very-weak" } });
    const slightlyWeak = await prisma.concept.create({ data: { courseId: course.id, name: "Slightly Weak", normalizedName: "slightly-weak" } });

    await prisma.studentConceptMastery.create({
      data: { userId, conceptId: veryWeak.id, overallMastery: 0.05, exposureCount: 2, attemptCount: 2, status: "LEARNING" },
    });
    await prisma.studentConceptMastery.create({
      data: { userId, conceptId: slightlyWeak.id, overallMastery: 0.28, exposureCount: 2, attemptCount: 2, status: "LEARNING" },
    });

    const ranked = await rankWeakConcepts(userId, course.id);
    expect(ranked!.map((c) => c.conceptId)).toEqual([veryWeak.id, slightlyWeak.id]);
  });

  it("ranks a recently-missed concept above an equally-weak one missed long ago", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const course = await prisma.course.create({ data: { userId, title: `Recency ${suffix}` } });
    const recentMiss = await prisma.concept.create({ data: { courseId: course.id, name: "Recent Miss", normalizedName: "recent-miss" } });
    const staleMiss = await prisma.concept.create({ data: { courseId: course.id, name: "Stale Miss", normalizedName: "stale-miss" } });

    const now = new Date();
    const longAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    await prisma.studentConceptMastery.create({
      data: {
        userId,
        conceptId: recentMiss.id,
        overallMastery: 0.2,
        exposureCount: 2,
        attemptCount: 2,
        status: "LEARNING",
        lastFailureAt: now,
      },
    });
    await prisma.studentConceptMastery.create({
      data: {
        userId,
        conceptId: staleMiss.id,
        overallMastery: 0.2,
        exposureCount: 2,
        attemptCount: 2,
        status: "LEARNING",
        lastFailureAt: longAgo,
      },
    });

    const ranked = await rankWeakConcepts(userId, course.id, now);
    expect(ranked!.map((c) => c.conceptId)).toEqual([recentMiss.id, staleMiss.id]);
  });

  it("ranks a concept blocking more dependents above an equally-weak concept blocking none", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const course = await prisma.course.create({ data: { userId, title: `Unlock value ${suffix}` } });
    const blocker = await prisma.concept.create({ data: { courseId: course.id, name: "Blocker", normalizedName: "blocker" } });
    const isolated = await prisma.concept.create({ data: { courseId: course.id, name: "Isolated", normalizedName: "isolated" } });
    const dependent1 = await prisma.concept.create({ data: { courseId: course.id, name: "Dependent 1", normalizedName: "dependent-1" } });
    const dependent2 = await prisma.concept.create({ data: { courseId: course.id, name: "Dependent 2", normalizedName: "dependent-2" } });

    await prisma.conceptRelationship.createMany({
      data: [
        { sourceConceptId: blocker.id, targetConceptId: dependent1.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
        { sourceConceptId: blocker.id, targetConceptId: dependent2.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
      ],
    });

    await prisma.studentConceptMastery.create({
      data: { userId, conceptId: blocker.id, overallMastery: 0.2, exposureCount: 2, attemptCount: 2, status: "LEARNING" },
    });
    await prisma.studentConceptMastery.create({
      data: { userId, conceptId: isolated.id, overallMastery: 0.2, exposureCount: 2, attemptCount: 2, status: "LEARNING" },
    });

    const ranked = await rankWeakConcepts(userId, course.id);
    const blockerEntry = ranked!.find((c) => c.conceptId === blocker.id)!;
    const isolatedEntry = ranked!.find((c) => c.conceptId === isolated.id)!;
    expect(blockerEntry.unlocksCount).toBe(2);
    expect(isolatedEntry.unlocksCount).toBe(0);
    expect(blockerEntry.score).toBeGreaterThan(isolatedEntry.score);
    expect(ranked!.map((c) => c.conceptId)).toEqual([blocker.id, isolated.id]);
  });

  it("never overwrites or duplicates evidence — scores are stable across repeated calls (pure read, no side effects)", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const course = await prisma.course.create({ data: { userId, title: `Idempotent ${suffix}` } });
    const concept = await prisma.concept.create({ data: { courseId: course.id, name: "Stable", normalizedName: "stable" } });
    await prisma.studentConceptMastery.create({
      data: { userId, conceptId: concept.id, overallMastery: 0.3, exposureCount: 3, attemptCount: 3, status: "LEARNING" },
    });

    const first = await rankWeakConcepts(userId, course.id);
    const second = await rankWeakConcepts(userId, course.id);
    expect(first![0].score).toBe(second![0].score);
  });
});
