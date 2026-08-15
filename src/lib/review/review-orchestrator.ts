import { prisma } from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { Question, ReviewEvent, ReviewItem, ReviewOutcome, StudySession, StudySessionQuestion } from "@/generated/prisma/client";
import { getOrGenerateQuestion } from "@/lib/learning/question-generator";
import { clampDifficulty, getRecentPerformance } from "@/lib/learning/difficulty-engine";
import { getMastery } from "@/lib/services/student-knowledge";
import { getSessionState, type SessionState } from "@/lib/learning/study-session";
import { scheduleReview, type ReviewItemSnapshot, addDays } from "./scheduler";
import { ensureReviewItemsForCourse, getDueReviews } from "./review-queries";
import { INITIAL_DIFFICULTY, MAX_REVIEW_SESSION_SIZE } from "./config";
import { REVIEW_OUTCOMES } from "./types";

/**
 * The review-session pipeline (spec §13). Deliberately reuses almost
 * everything from Phase 5's Active Recall infrastructure rather than
 * building a parallel one (spec §10, §13): question generation
 * (getOrGenerateQuestion), the answer/evaluation/recordLearningOutcome path
 * (submitAnswer, hint, reveal — all via the *existing*
 * /api/study-sessions/:id/* routes, completely untouched by Phase 9), and
 * session state reconstruction (getSessionState). A "review session" is a
 * StudySession in REVIEW mode; the only genuinely new domain action here is
 * rating recall quality and rescheduling — everything else is the same
 * mechanism Active Recall already uses.
 */

export class NoReviewsDueError extends Error {
  constructor() {
    super("No reviews are due right now.");
  }
}
export class ReviewSessionNotFoundError extends Error {
  constructor() {
    super("Review session not found.");
  }
}
export class ReviewSessionNotActiveError extends Error {
  constructor() {
    super("This review session is no longer active.");
  }
}
export class ReviewQuestionGenerationFailedError extends Error {
  constructor() {
    super("Could not generate a review question right now. Please try again.");
  }
}
export class ReviewAnswerNotSubmittedError extends Error {
  constructor() {
    super("Answer this question before rating your recall.");
  }
}
export class ReviewNotRatedError extends Error {
  constructor() {
    super("Rate your recall on the current question before continuing.");
  }
}
export class InvalidReviewOutcomeError extends Error {
  constructor() {
    super("Invalid review outcome.");
  }
}
export class ReviewSessionCompleteError extends Error {
  constructor() {
    super("This review session has no more due items — complete it to see the summary.");
  }
}

async function nextPosition(sessionId: string): Promise<number> {
  const last = await prisma.studySessionQuestion.findFirst({
    where: { sessionId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  return (last?.position ?? 0) + 1;
}

async function createReviewSessionQuestion(sessionId: string, questionId: string, reason: string): Promise<StudySessionQuestion> {
  const position = await nextPosition(sessionId);
  return prisma.studySessionQuestion.create({ data: { sessionId, questionId, position, reason } });
}

function dueReason(overdueDays: number): string {
  if (overdueDays < 1) return "Due for review.";
  const days = Math.floor(overdueDays);
  return `Due for review — ${days} day${days === 1 ? "" : "s"} overdue.`;
}

/** Reuse-before-generate at a fixed RECALL type (spec §7 — retrieval practice, no adaptive-engine question-type selection needed here), falling back to difficulty 1 once if the first attempt is refused. */
async function generateReviewQuestion(
  courseId: string,
  userId: string,
  conceptId: string,
  difficulty: number,
  excludeQuestionIds: string[],
): Promise<Question> {
  const primary = await getOrGenerateQuestion({
    courseId,
    conceptId,
    type: "RECALL",
    difficulty,
    userId,
    purpose: "QUESTION_GENERATION",
    excludeQuestionIds,
  });
  if (primary) return primary;

  const fallback = await getOrGenerateQuestion({
    courseId,
    conceptId,
    type: "RECALL",
    difficulty: 1,
    userId,
    purpose: "QUESTION_GENERATION",
    excludeQuestionIds,
  });
  if (fallback) return fallback;

  throw new ReviewQuestionGenerationFailedError();
}

/** No-AI-call check for an in-progress REVIEW session, so the UI can silently resume on page load (mirrors getActiveSessionId, but scoped to REVIEW mode so it never collides with an in-progress Active Recall session). Returns null if the course isn't found/owned. */
export async function getActiveReviewSessionId(userId: string, courseId: string): Promise<string | null> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId }, select: { id: true } });
  if (!course) return null;

  const session = await prisma.studySession.findFirst({
    where: { userId, courseId, status: "ACTIVE", mode: "REVIEW" },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  return session?.id ?? null;
}

export interface ReviewSessionStartResult extends SessionState {
  dueCount: number;
}

/** Resumes an ACTIVE review session for this user/course if one exists, otherwise starts one on the most-overdue due concept. Throws NoReviewsDueError if nothing is due. Returns null if the course isn't found/owned. */
export async function getOrStartReviewSession(userId: string, courseId: string): Promise<ReviewSessionStartResult | null> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId } });
  if (!course) return null;

  const existing = await prisma.studySession.findFirst({
    where: { userId, courseId, status: "ACTIVE", mode: "REVIEW" },
    orderBy: { startedAt: "desc" },
  });
  if (existing) {
    const state = await getSessionState(existing.id, userId);
    if (!state) return null;
    const due = await getDueReviews(userId, courseId);
    return { ...state, dueCount: due.length };
  }

  await ensureReviewItemsForCourse(userId, courseId);
  const due = await getDueReviews(userId, courseId);
  if (due.length === 0) throw new NoReviewsDueError();

  const first = due[0];
  const difficulty = clampDifficulty(Math.round(first.difficulty));
  const question = await generateReviewQuestion(courseId, userId, first.conceptId, difficulty, []);

  const targetLength = Math.min(due.length, MAX_REVIEW_SESSION_SIZE);
  const session = await prisma.studySession.create({
    data: { userId, courseId, mode: "REVIEW", targetLength },
  });
  await createReviewSessionQuestion(session.id, question.id, dueReason(first.overdueDays));

  const state = await getSessionState(session.id, userId);
  if (!state) throw new ReviewSessionNotFoundError();
  return { ...state, dueCount: due.length };
}

export interface NextReviewQuestionResult {
  sessionQuestion: StudySessionQuestion & { question: Question & { concept: { name: string } } };
}

/** Advances to the next due concept not yet asked this session. Throws ReviewSessionCompleteError once the due queue (or targetLength) is exhausted — the caller should complete the session at that point. */
export async function nextReviewQuestion(sessionId: string, userId: string): Promise<NextReviewQuestionResult> {
  const session = await prisma.studySession.findFirst({ where: { id: sessionId, userId, mode: "REVIEW" } });
  if (!session || session.status !== "ACTIVE") throw new ReviewSessionNotActiveError();
  if (session.questionsAnswered >= session.targetLength) throw new ReviewSessionCompleteError();

  const previous = await prisma.studySessionQuestion.findFirst({
    where: { sessionId },
    orderBy: { position: "desc" },
    include: { question: true },
  });
  if (previous && !previous.answeredAt) {
    throw new Error("Answer the current question before requesting the next one.");
  }
  if (previous?.attemptId) {
    const rated = await prisma.reviewEvent.findUnique({ where: { attemptId: previous.attemptId }, select: { id: true } });
    if (!rated) throw new ReviewNotRatedError();
  }

  const [due, asked] = await Promise.all([
    getDueReviews(userId, session.courseId),
    prisma.studySessionQuestion.findMany({ where: { sessionId }, select: { questionId: true, question: { select: { conceptId: true } } } }),
  ]);
  const askedConceptIds = new Set(asked.map((a) => a.question.conceptId));
  const askedQuestionIds = asked.map((a) => a.questionId);

  const nextDue = due.find((d) => !askedConceptIds.has(d.conceptId));
  if (!nextDue) throw new ReviewSessionCompleteError();

  const difficulty = clampDifficulty(Math.round(nextDue.difficulty));
  const question = await generateReviewQuestion(session.courseId, userId, nextDue.conceptId, difficulty, askedQuestionIds);
  const sessionQuestion = await createReviewSessionQuestion(sessionId, question.id, dueReason(nextDue.overdueDays));

  return {
    sessionQuestion: { ...sessionQuestion, question: { ...question, concept: { name: nextDue.conceptName } } },
  };
}

export interface SubmitReviewRatingInput {
  sessionId: string;
  userId: string;
  sessionQuestionId: string;
  outcome: ReviewOutcome;
}

export interface SubmitReviewRatingResult {
  reviewItem: ReviewItem;
  event: ReviewEvent;
  /** True if this request found an already-recorded rating for the same attempt instead of creating a new one (spec §21 idempotency). */
  alreadyRated: boolean;
}

function isUniqueConstraintOn(error: unknown, field: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    Array.isArray((error.meta as { target?: unknown })?.target) &&
    ((error.meta as { target: string[] }).target).includes(field)
  );
}

/**
 * Records a self-rated recall outcome and reschedules the review (spec
 * §5-6). Idempotent (spec §21): the underlying LearningAttempt id is the
 * natural idempotency key — a ReviewEvent already existing for it (checked
 * up front, and again via the attemptId unique constraint if two requests
 * race) means "already rated," and the existing result is returned rather
 * than rescheduling a second time.
 */
export async function submitReviewRating(input: SubmitReviewRatingInput): Promise<SubmitReviewRatingResult> {
  if (!REVIEW_OUTCOMES.includes(input.outcome)) throw new InvalidReviewOutcomeError();

  const session = await prisma.studySession.findFirst({ where: { id: input.sessionId, userId: input.userId, mode: "REVIEW" } });
  if (!session) throw new ReviewSessionNotFoundError();

  const sessionQuestion = await prisma.studySessionQuestion.findFirst({
    where: { id: input.sessionQuestionId, sessionId: session.id },
    include: { question: true },
  });
  if (!sessionQuestion) throw new ReviewSessionNotFoundError();
  if (!sessionQuestion.answeredAt || !sessionQuestion.attemptId) throw new ReviewAnswerNotSubmittedError();

  const attemptId = sessionQuestion.attemptId;

  const existingEvent = await prisma.reviewEvent.findUnique({ where: { attemptId } });
  if (existingEvent) {
    const reviewItem = await prisma.reviewItem.findUniqueOrThrow({ where: { id: existingEvent.reviewItemId } });
    return { reviewItem, event: existingEvent, alreadyRated: true };
  }

  const conceptId = sessionQuestion.question.conceptId;
  const reviewItem = await prisma.reviewItem.upsert({
    where: { userId_conceptId: { userId: input.userId, conceptId } },
    update: {},
    create: {
      userId: input.userId,
      courseId: session.courseId,
      conceptId,
      status: "NEW",
      interval: 0,
      stability: 0,
      difficulty: INITIAL_DIFFICULTY,
      repetitionCount: 0,
      lapseCount: 0,
      nextReviewAt: new Date(),
    },
  });

  const [mastery, recentScores] = await Promise.all([
    getMastery(input.userId, conceptId),
    getRecentPerformance(input.userId, conceptId),
  ]);
  const recentPerformance = recentScores.length > 0 ? recentScores.reduce((sum, v) => sum + v, 0) / recentScores.length : null;

  const now = new Date();
  const snapshot: ReviewItemSnapshot = {
    status: reviewItem.status,
    interval: reviewItem.interval,
    stability: reviewItem.stability,
    difficulty: reviewItem.difficulty,
    repetitionCount: reviewItem.repetitionCount,
    lapseCount: reviewItem.lapseCount,
  };
  const scheduled = scheduleReview({
    reviewItem: snapshot,
    outcome: input.outcome,
    studentMastery: mastery?.overallMastery ?? null,
    recentPerformance,
    now,
  });

  try {
    const [updatedItem, event] = await prisma.$transaction([
      prisma.reviewItem.update({
        where: { id: reviewItem.id },
        data: {
          status: scheduled.status,
          interval: scheduled.interval,
          stability: scheduled.stability,
          difficulty: scheduled.difficulty,
          repetitionCount: scheduled.repetitionCount,
          lapseCount: scheduled.lapseCount,
          lastReviewedAt: now,
          nextReviewAt: scheduled.nextReviewAt,
        },
      }),
      prisma.reviewEvent.create({
        data: {
          reviewItemId: reviewItem.id,
          userId: input.userId,
          conceptId,
          outcome: input.outcome,
          previousInterval: reviewItem.interval,
          newInterval: scheduled.interval,
          attemptId,
          source: "REVIEW_SESSION",
          reviewedAt: now,
        },
      }),
    ]);
    return { reviewItem: updatedItem, event, alreadyRated: false };
  } catch (error) {
    // A concurrent duplicate submission raced us to the unique attemptId constraint — treat it the same as the up-front idempotency check.
    if (isUniqueConstraintOn(error, "attemptId")) {
      const event = await prisma.reviewEvent.findUniqueOrThrow({ where: { attemptId } });
      const currentItem = await prisma.reviewItem.findUniqueOrThrow({ where: { id: event.reviewItemId } });
      return { reviewItem: currentItem, event, alreadyRated: true };
    }
    throw error;
  }
}

export interface ReviewSessionSummary {
  session: StudySession;
  reviewed: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
  /** Earliest next review date among items rated this session, or null if nothing was rated. */
  nextReviewAt: Date | null;
}

/** Completes the underlying StudySession (reused from study-session.ts semantics) and tallies this session's rated outcomes from ReviewEvent rows keyed by the session's own attempt ids — never a separate, guessed time window. */
export async function completeReviewSession(sessionId: string, userId: string): Promise<ReviewSessionSummary | null> {
  const session = await prisma.studySession.findFirst({ where: { id: sessionId, userId, mode: "REVIEW" } });
  if (!session) return null;

  const updated =
    session.status === "ACTIVE"
      ? await prisma.studySession.update({ where: { id: session.id }, data: { status: "COMPLETED", completedAt: new Date() } })
      : session;

  return buildReviewSessionSummary(updated);
}

export async function getReviewSessionSummary(sessionId: string, userId: string): Promise<ReviewSessionSummary | null> {
  const session = await prisma.studySession.findFirst({ where: { id: sessionId, userId, mode: "REVIEW" } });
  if (!session) return null;
  return buildReviewSessionSummary(session);
}

async function buildReviewSessionSummary(session: StudySession): Promise<ReviewSessionSummary> {
  const sessionQuestions = await prisma.studySessionQuestion.findMany({ where: { sessionId: session.id }, select: { attemptId: true } });
  const attemptIds = sessionQuestions.map((q) => q.attemptId).filter((id): id is string => id != null);

  const events = attemptIds.length > 0 ? await prisma.reviewEvent.findMany({ where: { attemptId: { in: attemptIds } } }) : [];

  const tally = { again: 0, hard: 0, good: 0, easy: 0 };
  for (const event of events) {
    if (event.outcome === "AGAIN") tally.again += 1;
    else if (event.outcome === "HARD") tally.hard += 1;
    else if (event.outcome === "GOOD") tally.good += 1;
    else if (event.outcome === "EASY") tally.easy += 1;
  }

  const nextReviewAt =
    events.length > 0
      ? new Date(Math.min(...events.map((e) => addDays(e.reviewedAt, e.newInterval).getTime())))
      : null;

  return {
    session,
    reviewed: events.length,
    again: tally.again,
    hard: tally.hard,
    good: tally.good,
    easy: tally.easy,
    nextReviewAt,
  };
}

export function reviewErrorStatus(error: unknown): { status: number; message: string } {
  if (error instanceof NoReviewsDueError) return { status: 422, message: error.message };
  if (error instanceof ReviewSessionNotFoundError) return { status: 404, message: error.message };
  if (error instanceof ReviewSessionNotActiveError) return { status: 409, message: error.message };
  if (error instanceof ReviewSessionCompleteError) return { status: 409, message: error.message };
  if (error instanceof ReviewAnswerNotSubmittedError) return { status: 409, message: error.message };
  if (error instanceof ReviewNotRatedError) return { status: 409, message: error.message };
  if (error instanceof InvalidReviewOutcomeError) return { status: 400, message: error.message };
  if (error instanceof ReviewQuestionGenerationFailedError) return { status: 502, message: error.message };
  if (error instanceof Error && error.message.startsWith("Answer the current question")) {
    return { status: 409, message: error.message };
  }
  console.error("Review session operation failed:", error);
  return { status: 500, message: "Something went wrong. Please try again." };
}
