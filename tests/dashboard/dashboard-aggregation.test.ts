import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { getStudyStreak } from "@/lib/dashboard/streak";
import { getStudyNotifications } from "@/lib/dashboard/notifications";
import { getTodaysStudyPlan } from "@/lib/dashboard/study-plan";
import { getCourseAnalytics } from "@/lib/dashboard/analytics";

/**
 * Phase 10 dashboard aggregation — real Postgres, zero Claude mocking
 * required: none of these functions ever call Claude (spec §10.19 — no AI
 * for simple calculations), they only compose existing Phase 4/6/8/9
 * reads.
 */
describe("dashboard aggregation (Phase 10)", () => {
  let userId: string;
  let courseId: string;
  let strongConceptId: string;
  let weakConceptId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-dashboard-${suffix}@example.com` } });
    userId = user.id;

    const course = await prisma.course.create({ data: { userId, title: "Networking", knowledgeStatus: "READY" } });
    courseId = course.id;

    const strong = await prisma.concept.create({
      data: { courseId, name: "TCP/IP", normalizedName: "tcp-ip", difficulty: 1 },
    });
    strongConceptId = strong.id;
    const weak = await prisma.concept.create({
      data: { courseId, name: "Firewalls", normalizedName: "firewalls", difficulty: 3 },
    });
    weakConceptId = weak.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  beforeEach(async () => {
    await prisma.reviewEvent.deleteMany({ where: { userId } });
    await prisma.reviewItem.deleteMany({ where: { userId } });
    await prisma.examResult.deleteMany({ where: { exam: { userId } } });
    await prisma.exam.deleteMany({ where: { userId } });
    await prisma.knowledgeEvidence.deleteMany({ where: { userId } });
    await prisma.learningAttempt.deleteMany({ where: { userId } });
    await prisma.studentConceptMastery.deleteMany({ where: { userId } });
    await prisma.learningGoal.deleteMany({ where: { userId } });
  });

  async function seedMastery(conceptId: string, overallMastery: number, exposureCount = 3) {
    await prisma.studentConceptMastery.create({
      data: {
        userId,
        conceptId,
        overallMastery,
        exposureCount,
        attemptCount: exposureCount,
        successCount: Math.round(exposureCount * overallMastery),
        status: overallMastery >= 0.7 ? "STRONG" : overallMastery > 0 ? "LEARNING" : "UNKNOWN",
      },
    });
  }

  async function seedAttempt(conceptId: string, createdAt: Date, durationSeconds = 60, score = 0.8) {
    await prisma.learningAttempt.create({
      data: { userId, conceptId, activityType: "RECALL", score, correctness: score, durationSeconds, createdAt },
    });
  }

  describe("getStudyStreak", () => {
    it("is 0 with no learning activity", async () => {
      expect(await getStudyStreak(userId, courseId)).toBe(0);
    });

    it("counts today as a 1-day streak after a single attempt", async () => {
      await seedAttempt(strongConceptId, new Date());
      expect(await getStudyStreak(userId, courseId)).toBe(1);
    });

    it("counts consecutive days, breaking on a gap", async () => {
      const now = new Date();
      await seedAttempt(strongConceptId, now);
      await seedAttempt(strongConceptId, new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000));
      await seedAttempt(strongConceptId, new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000));
      await seedAttempt(strongConceptId, new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)); // gap — not consecutive
      expect(await getStudyStreak(userId, courseId, now)).toBe(3);
    });
  });

  describe("getStudyNotifications", () => {
    it("surfaces a weak-concept warning when a practiced concept is weak", async () => {
      await seedMastery(weakConceptId, 0.2);
      const notifications = await getStudyNotifications(userId, courseId);
      expect(notifications.some((n) => n.id === "weak-concept")).toBe(true);
    });

    it("surfaces a due-reviews notification driven by real ReviewItem state, not a fabricated count", async () => {
      await seedMastery(weakConceptId, 0.5);
      await prisma.reviewItem.create({
        data: {
          userId,
          courseId,
          conceptId: weakConceptId,
          status: "REVIEW",
          interval: 1,
          stability: 1,
          nextReviewAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      });
      const notifications = await getStudyNotifications(userId, courseId);
      const dueNotification = notifications.find((n) => n.id === "reviews-due");
      expect(dueNotification).toBeDefined();
      expect(dueNotification!.message).toContain("1 review");
    });

    it("surfaces an upcoming-exam notification only when the goal date is within the configured window", async () => {
      await prisma.learningGoal.create({
        data: { userId, courseId, type: "EXAM", targetDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) },
      });
      const notifications = await getStudyNotifications(userId, courseId);
      expect(notifications.some((n) => n.id === "exam-soon")).toBe(true);
    });

    it("returns no notifications for a course with no activity, no due reviews, and no goals", async () => {
      const notifications = await getStudyNotifications(userId, courseId);
      expect(notifications).toHaveLength(0);
    });
  });

  describe("getTodaysStudyPlan", () => {
    it("includes a REVIEW item when reviews are due, sized to the due count", async () => {
      await seedMastery(weakConceptId, 0.5);
      await prisma.reviewItem.create({
        data: {
          userId,
          courseId,
          conceptId: weakConceptId,
          status: "REVIEW",
          interval: 1,
          stability: 1,
          nextReviewAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      });
      const plan = await getTodaysStudyPlan(userId, courseId);
      expect(plan.some((item) => item.kind === "REVIEW")).toBe(true);
    });

    it("never lists the same concept twice even when it qualifies for multiple action types", async () => {
      await seedMastery(weakConceptId, 0.1);
      const plan = await getTodaysStudyPlan(userId, courseId);
      const conceptIds = plan.filter((item) => item.kind === "CONCEPT").map((item) => item.conceptId);
      expect(new Set(conceptIds).size).toBe(conceptIds.length);
    });

    it("ranks a much weaker, actively-struggling concept ahead of a much stronger one", async () => {
      const now = new Date();
      await seedMastery(weakConceptId, 0.1);
      await seedAttempt(weakConceptId, now, 60, 0.1); // recent failing attempt -> real, current weakness signal
      await seedMastery(strongConceptId, 0.95);
      await seedAttempt(strongConceptId, now, 60, 0.95); // recent success streak -> eligible for CHALLENGE, not urgency

      const plan = await getTodaysStudyPlan(userId, courseId, 60);
      const priorities = plan.map((item) => item.priority);
      expect(priorities).toEqual([...priorities].sort((a, b) => b - a));

      const weakIndex = plan.findIndex((item) => item.conceptId === weakConceptId);
      const strongIndex = plan.findIndex((item) => item.conceptId === strongConceptId);
      expect(weakIndex).toBeGreaterThanOrEqual(0);
      if (strongIndex >= 0) expect(weakIndex).toBeLessThan(strongIndex);
    });

    it("respects the available-time budget while always including at least the top item", async () => {
      await seedMastery(weakConceptId, 0.1);
      const plan = await getTodaysStudyPlan(userId, courseId, 1); // 1 minute — smaller than any single activity
      expect(plan.length).toBeGreaterThanOrEqual(1);
      if (plan.length > 1) {
        const total = plan.reduce((sum, item) => sum + item.estimatedMinutes, 0);
        expect(total).toBeLessThanOrEqual(plan[0].estimatedMinutes + 1);
      }
    });

    it("still surfaces concept suggestions for a never-studied course — an unattempted concept is maximal weakness by design, not skipped", async () => {
      const plan = await getTodaysStudyPlan(userId, courseId);
      expect(plan.length).toBeGreaterThan(0);
      expect(plan.every((item) => item.kind === "CONCEPT")).toBe(true);
    });

    it("returns an empty plan for a course with no concepts at all", async () => {
      const emptyCourse = await prisma.course.create({ data: { userId, title: "Empty", knowledgeStatus: "READY" } });
      const plan = await getTodaysStudyPlan(userId, emptyCourse.id);
      expect(plan).toEqual([]);
    });
  });

  describe("getCourseAnalytics", () => {
    it("returns null for a course that doesn't exist", async () => {
      expect(await getCourseAnalytics(userId, "nonexistent-course-id")).toBeNull();
    });

    it("aggregates questions answered, study time, and accuracy from real LearningAttempt rows", async () => {
      await seedMastery(strongConceptId, 0.8, 4);
      const now = new Date();
      await seedAttempt(strongConceptId, now, 120, 0.9);
      await seedAttempt(strongConceptId, now, 90, 0.7);

      const analytics = await getCourseAnalytics(userId, courseId, now);
      expect(analytics).not.toBeNull();
      expect(analytics!.questionsAnswered).toBe(2);
      expect(analytics!.studyTimeMinutes).toBe(Math.round((120 + 90) / 60));
      expect(analytics!.accuracy).not.toBeNull();
    });

    it("tallies review outcomes from ReviewEvent rows", async () => {
      await seedMastery(weakConceptId, 0.4);
      const reviewItem = await prisma.reviewItem.create({
        data: { userId, courseId, conceptId: weakConceptId, status: "REVIEW", interval: 3, stability: 3, nextReviewAt: new Date() },
      });
      const attempt = await prisma.learningAttempt.create({
        data: { userId, conceptId: weakConceptId, activityType: "RECALL", score: 0.9, correctness: 0.9 },
      });
      await prisma.reviewEvent.create({
        data: {
          reviewItemId: reviewItem.id,
          userId,
          conceptId: weakConceptId,
          outcome: "GOOD",
          previousInterval: 1,
          newInterval: 3,
          attemptId: attempt.id,
        },
      });

      const analytics = await getCourseAnalytics(userId, courseId);
      expect(analytics!.reviewOutcomeTally.good).toBe(1);
      expect(analytics!.reviewsCompleted).toBe(1);
    });

    it("includes graded exam results", async () => {
      const exam = await prisma.exam.create({
        data: { userId, courseId, mode: "WRITTEN", status: "GRADED", questionCount: 5 },
      });
      await prisma.examResult.create({
        data: {
          examId: exam.id,
          overallScore: 4,
          percentage: 0.8,
          passed: true,
          totalQuestions: 5,
          correctAnswers: 4,
          partialAnswers: 0,
          incorrectAnswers: 1,
          unanswered: 0,
          timeSpentSeconds: 600,
          conceptScores: {},
          cognitiveScores: {},
          mistakeSummary: {},
        },
      });

      const analytics = await getCourseAnalytics(userId, courseId);
      expect(analytics!.examScores).toHaveLength(1);
      expect(analytics!.examScores[0].percentage).toBe(0.8);
      expect(analytics!.examScores[0].passed).toBe(true);
    });

    it("builds a mastery trend point for the current week from KnowledgeEvidence", async () => {
      await prisma.knowledgeEvidence.create({
        data: { userId, conceptId: strongConceptId, sourceType: "QUESTION", outcome: "SUCCESS", score: 0.85 },
      });
      const analytics = await getCourseAnalytics(userId, courseId);
      const currentWeek = analytics!.masteryTrend[analytics!.masteryTrend.length - 1];
      expect(currentWeek.averageScore).toBeCloseTo(0.85, 5);
    });
  });
});
