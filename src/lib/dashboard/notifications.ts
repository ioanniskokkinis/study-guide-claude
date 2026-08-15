import { prisma } from "@/lib/db/prisma";
import { bucketForStatus, getCourseMastery } from "@/lib/services/student-knowledge";
import { getReviewState } from "@/lib/review/review-queries";
import { getStudyStreak } from "./streak";
import { UPCOMING_EXAM_NOTIFICATION_WITHIN_DAYS } from "./config";

/**
 * Real, data-derived notifications (spec §10.17) — every message here comes
 * straight from an existing read (due reviews, mastery buckets, the study
 * streak, an EXAM-type LearningGoal's target date). No AI call, no
 * fabricated content: "AI should be used where it adds value, not for
 * simple calculations" (spec §10.19).
 */

export type NotificationLevel = "info" | "warning" | "success";

export interface StudyNotification {
  id: string;
  level: NotificationLevel;
  message: string;
}

export async function getStudyNotifications(userId: string, courseId: string, now: Date = new Date()): Promise<StudyNotification[]> {
  const [reviewState, mastery, streak, examGoal] = await Promise.all([
    getReviewState(userId, courseId, now),
    getCourseMastery(userId, courseId),
    getStudyStreak(userId, courseId, now),
    prisma.learningGoal.findFirst({
      where: { userId, courseId, type: "EXAM", targetDate: { gte: now } },
      orderBy: { targetDate: "asc" },
      select: { targetDate: true },
    }),
  ]);

  const notifications: StudyNotification[] = [];

  if (reviewState && reviewState.dueCount > 0) {
    notifications.push({
      id: "reviews-due",
      level: reviewState.overdueCount > 0 ? "warning" : "info",
      message: `You have ${reviewState.dueCount} review${reviewState.dueCount === 1 ? "" : "s"} due today${
        reviewState.overdueCount > 0 ? ` (${reviewState.overdueCount} overdue)` : ""
      }.`,
    });
  }

  if (mastery) {
    const practiced = mastery.concepts.filter((c) => c.exposureCount > 0);
    const weakConcepts = practiced.filter((c) => bucketForStatus(c.status) === "weak");

    if (weakConcepts.length > 0) {
      const worst = weakConcepts.reduce((min, c) => (c.overallMastery < min.overallMastery ? c : min));
      notifications.push({
        id: "weak-concept",
        level: "warning",
        message:
          weakConcepts.length === 1
            ? `${worst.conceptName} is becoming a weak concept.`
            : `${weakConcepts.length} concepts need attention, especially ${worst.conceptName}.`,
      });
    } else if (practiced.length > 0 && practiced.some((c) => bucketForStatus(c.status) === "strong")) {
      const strongCount = practiced.filter((c) => bucketForStatus(c.status) === "strong").length;
      notifications.push({
        id: "ready-for-challenge",
        level: "success",
        message: `You're doing well across ${strongCount} concept${strongCount === 1 ? "" : "s"} — a good time to try harder material.`,
      });
    }
  }

  if (streak >= 2) {
    notifications.push({ id: "streak", level: "success", message: `🔥 ${streak}-day study streak!` });
  }

  if (examGoal?.targetDate) {
    const daysUntil = Math.ceil((examGoal.targetDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (daysUntil <= UPCOMING_EXAM_NOTIFICATION_WITHIN_DAYS) {
      notifications.push({
        id: "exam-soon",
        level: "warning",
        message: `📚 Your exam is in ${daysUntil} day${daysUntil === 1 ? "" : "s"}.`,
      });
    }
  }

  return notifications;
}
