import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { getNextLearningAction, NoConceptsAvailableError } from "./adaptive-engine";
import { createSessionQuestion, generateForAction, QuestionGenerationFailedError } from "./question-serving";

/**
 * Question Prefetch Service (Phase 17 §4-11, §22-30, §55-57). Keeps a small,
 * bounded number of `StudySessionQuestion` rows ready ahead of the student
 * so "Next" is normally instant instead of waiting on a Claude call.
 *
 * Deliberately thin: every actual decision (which concept, what
 * type/difficulty) still comes from the Phase 6 Adaptive Engine
 * (`getNextLearningAction`), and every actual generation still goes through
 * the one existing question-generation path (`generateForAction` ->
 * `getOrGenerateQuestion`, which itself reuses-before-generating and
 * deduplicates — §10/§27/§30). This file adds *when* and *how many* to call
 * that existing pipeline, never a second way to call Claude for a question.
 */

/** Sequential generation only (Phase 17 §41-42) — a burst of concurrent Claude calls for background convenience would compete with the student's own in-flight request for the same rate limits. */
async function fillBuffer(sessionId: string, userId: string): Promise<{ generated: number; failed: number }> {
  const session = await prisma.studySession.findUnique({ where: { id: sessionId } });
  if (!session || session.status !== "ACTIVE") return { generated: 0, failed: 0 };

  let generated = 0;
  let failed = 0;

  for (let i = 0; i < env.ACTIVE_RECALL_PREFETCH_COUNT; i++) {
    const [readyCount, answeredCount, askedQuestions] = await Promise.all([
      prisma.studySessionQuestion.count({ where: { sessionId, answeredAt: null } }),
      prisma.studySession.findUniqueOrThrow({ where: { id: sessionId }, select: { questionsAnswered: true, targetLength: true } }),
      prisma.studySessionQuestion.findMany({ where: { sessionId }, select: { questionId: true } }),
    ]);

    // Bounded (Phase 17 §11): never keep more ready than the buffer size,
    // and never prefetch past what the session will actually need.
    const remainingInSession = answeredCount.targetLength - answeredCount.questionsAnswered - readyCount;
    if (readyCount >= env.ACTIVE_RECALL_PREFETCH_COUNT || remainingInSession <= 0) break;

    try {
      const { action } = await getNextLearningAction({ userId, courseId: session.courseId });
      const excludeQuestionIds = askedQuestions.map((q) => q.questionId);
      const question = await generateForAction(session.courseId, userId, action, excludeQuestionIds, "ACTIVE_RECALL_QUESTION_PREFETCH");
      await createSessionQuestion(sessionId, question.id, action.reason.message);
      generated += 1;
    } catch (error) {
      // One failed generation must never take down the whole buffer or the
      // session (Phase 17 §40) — stop this top-up pass; a later trigger
      // (the next answer, or the next /next call) will try again.
      failed += 1;
      if (!(error instanceof NoConceptsAvailableError) && !(error instanceof QuestionGenerationFailedError)) {
        console.error("Active Recall prefetch: question generation failed:", error);
      }
      break;
    }
  }

  return { generated, failed };
}

/**
 * Tops up this session's ready-question buffer up to
 * `ACTIVE_RECALL_PREFETCH_COUNT`, generating nothing if it's already full
 * (idempotent — Phase 17 §10). Always fire-and-forget from callers (never
 * awaited on a path the student is waiting on — §29): every failure inside
 * is caught and logged, never thrown, so a caller doing `void
 * ensurePrefetchBuffer(...)` can never turn this into an unhandled
 * rejection.
 */
export async function ensurePrefetchBuffer(sessionId: string, userId: string): Promise<void> {
  try {
    const result = await fillBuffer(sessionId, userId);
    if (process.env.NODE_ENV !== "production" && (result.generated > 0 || result.failed > 0)) {
      console.log(`[ACTIVE_RECALL_PREFETCH] session=${sessionId} generated=${result.generated} failed=${result.failed}`);
    }
  } catch (error) {
    console.error("Active Recall prefetch buffer top-up failed:", error);
  }
}

/**
 * Lightweight stale-prefetch invalidation (Phase 17 §25/§65): called only
 * when an evaluation just moved a concept to a different mastery bucket.
 * Discards not-yet-served buffered questions for *that* concept (they were
 * chosen by the adaptive engine under the old, now-outdated state) and
 * refills the buffer from the engine's current recommendation. Answered
 * questions and questions on other concepts are never touched — this is
 * intentionally a narrow, session-scoped correction, not a rebuild.
 */
export async function invalidateStaleBufferForConcept(sessionId: string, conceptId: string, userId: string): Promise<void> {
  try {
    const stale = await prisma.studySessionQuestion.findMany({
      where: { sessionId, answeredAt: null, question: { conceptId } },
      select: { id: true },
    });
    if (stale.length === 0) return;

    await prisma.studySessionQuestion.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    if (process.env.NODE_ENV !== "production") {
      console.log(`[ACTIVE_RECALL_PREFETCH] session=${sessionId} invalidated=${stale.length} concept=${conceptId}`);
    }
    await ensurePrefetchBuffer(sessionId, userId);
  } catch (error) {
    console.error("Active Recall stale-prefetch invalidation failed:", error);
  }
}
