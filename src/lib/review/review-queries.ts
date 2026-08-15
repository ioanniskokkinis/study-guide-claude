import { prisma } from "@/lib/db/prisma";
import type { ReviewItem, ReviewItemStatus } from "@/generated/prisma/client";
import { INITIAL_DIFFICULTY, INITIAL_ONSET_DAYS, STREAK_LOOKBACK_DAYS } from "./config";
import { addDays } from "./scheduler";

/**
 * The canonical read side of the spaced-repetition system (spec §7: "do not
 * calculate due state differently in multiple places" — this is the one
 * definition every caller, UI, and the adaptive engine integration all use).
 */

/** A concept is due the moment `nextReviewAt` has passed — never recomputed differently elsewhere. */
export function isDue(item: { nextReviewAt: Date }, now: Date = new Date()): boolean {
  return item.nextReviewAt.getTime() <= now.getTime();
}

/** How many days overdue an item is; 0 if not yet due (never negative). */
export function overdueDays(item: { nextReviewAt: Date }, now: Date = new Date()): number {
  const ms = now.getTime() - item.nextReviewAt.getTime();
  return ms > 0 ? ms / (1000 * 60 * 60 * 24) : 0;
}

/**
 * Lazily creates a ReviewItem for every concept in this course the student
 * has actually been exposed to (StudentConceptMastery.exposureCount > 0)
 * but doesn't yet have a schedule for — mirrors StudentConceptMastery's own
 * lazy-creation pattern (spec §3): review items are never pre-populated for
 * a whole course up front, only for concepts the student has real evidence
 * on. Idempotent and cheap (bounded by course concept count); safe to call
 * on every due-query.
 */
export async function ensureReviewItemsForCourse(userId: string, courseId: string, now: Date = new Date()): Promise<void> {
  const exposedConcepts = await prisma.studentConceptMastery.findMany({
    where: { userId, concept: { courseId }, exposureCount: { gt: 0 } },
    select: { conceptId: true },
  });
  if (exposedConcepts.length === 0) return;

  const existing = await prisma.reviewItem.findMany({
    where: { userId, conceptId: { in: exposedConcepts.map((c) => c.conceptId) } },
    select: { conceptId: true },
  });
  const existingIds = new Set(existing.map((r) => r.conceptId));
  const toCreate = exposedConcepts.filter((c) => !existingIds.has(c.conceptId));
  if (toCreate.length === 0) return;

  await prisma.reviewItem.createMany({
    data: toCreate.map((c) => ({
      userId,
      courseId,
      conceptId: c.conceptId,
      status: "NEW" as ReviewItemStatus,
      interval: 0,
      stability: 0,
      difficulty: INITIAL_DIFFICULTY,
      repetitionCount: 0,
      lapseCount: 0,
      nextReviewAt: addDays(now, INITIAL_ONSET_DAYS),
    })),
    skipDuplicates: true,
  });
}

export interface DueReviewItem {
  id: string;
  conceptId: string;
  conceptName: string;
  courseId: string;
  status: ReviewItemStatus;
  interval: number;
  difficulty: number;
  nextReviewAt: Date;
  overdueDays: number;
}

/** Every ReviewItem for this student/course where `nextReviewAt <= now`, most-overdue first — the one canonical due query (spec §7). */
export async function getDueReviews(userId: string, courseId: string, now: Date = new Date()): Promise<DueReviewItem[]> {
  const rows = await prisma.reviewItem.findMany({
    where: { userId, courseId, nextReviewAt: { lte: now } },
    include: { concept: { select: { name: true } } },
    orderBy: { nextReviewAt: "asc" },
  });

  return rows.map((r) => ({
    id: r.id,
    conceptId: r.conceptId,
    conceptName: r.concept.name,
    courseId: r.courseId,
    status: r.status,
    interval: r.interval,
    difficulty: r.difficulty,
    nextReviewAt: r.nextReviewAt,
    overdueDays: overdueDays(r, now),
  }));
}

/** Returns null if the concept doesn't exist or isn't owned by `userId`, or has no review schedule yet. */
export async function getReviewItem(userId: string, conceptId: string): Promise<ReviewItem | null> {
  return prisma.reviewItem.findUnique({ where: { userId_conceptId: { userId, conceptId } } });
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Consecutive days (most recent backwards) on which at least one review was
 * completed for this course — a metric reliably derivable from persisted
 * ReviewEvent rows, not a vanity number (spec §16). If no review has
 * happened yet today, the streak still counts through yesterday (today
 * isn't "broken" until it ends without a review).
 */
export async function getReviewStreak(userId: string, courseId: string, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - STREAK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const events = await prisma.reviewEvent.findMany({
    where: { userId, concept: { courseId }, reviewedAt: { gte: since } },
    select: { reviewedAt: true },
  });
  if (events.length === 0) return 0;

  const reviewedDays = new Set(events.map((e) => dayKey(e.reviewedAt)));
  const cursor = new Date(now);
  if (!reviewedDays.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);

  let streak = 0;
  while (reviewedDays.has(dayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export interface ReviewState {
  dueCount: number;
  overdueCount: number;
  /** Earliest upcoming `nextReviewAt` across every item in this course, due or not — null if the student has no review items yet. */
  nextReviewAt: Date | null;
  reviewStreak: number;
}

/** The single state summary the UI needs (spec §16) — "Due now: 7, Overdue: 2" plus streak. Returns null if the course doesn't exist or isn't owned by `userId`. */
export async function getReviewState(userId: string, courseId: string, now: Date = new Date()): Promise<ReviewState | null> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId }, select: { id: true } });
  if (!course) return null;

  await ensureReviewItemsForCourse(userId, courseId, now);

  const [due, upcoming, reviewStreak] = await Promise.all([
    getDueReviews(userId, courseId, now),
    prisma.reviewItem.findFirst({
      where: { userId, courseId },
      orderBy: { nextReviewAt: "asc" },
      select: { nextReviewAt: true },
    }),
    getReviewStreak(userId, courseId, now),
  ]);

  return {
    dueCount: due.length,
    overdueCount: due.filter((d) => d.overdueDays >= 1).length,
    nextReviewAt: upcoming?.nextReviewAt ?? null,
    reviewStreak,
  };
}
