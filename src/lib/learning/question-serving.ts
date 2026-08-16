import { prisma } from "@/lib/db/prisma";
import { Prisma, type Question, type StudySessionQuestion } from "@/generated/prisma/client";
import { getOrGenerateQuestion } from "./question-generator";
import type { NextLearningAction } from "./adaptive-engine";

/**
 * The shared primitives both the live Active Recall flow (study-session.ts)
 * and the background prefetch service (question-prefetch.ts) use to turn an
 * adaptive-engine action into a served `StudySessionQuestion` row. Split out
 * on its own so the two call sites can depend on it without depending on
 * each other — study-session.ts triggers prefetch, and prefetch reuses this
 * exact generation path (Phase 17 §55: no second question-generation
 * pipeline), which would be a circular import if either module imported the
 * other directly.
 */

export class QuestionGenerationFailedError extends Error {
  constructor() {
    super("Could not generate a question right now. Please try again.");
  }
}

/** Tags the AiUsageLog request type (spec §28/§34) — REMEDIATION for retry/focused questions, ACTIVE_RECALL_QUESTION_PREFETCH for background buffer top-ups, QUESTION_GENERATION otherwise. */
export type QuestionGenerationPurpose = "QUESTION_GENERATION" | "REMEDIATION" | "ACTIVE_RECALL_QUESTION_PREFETCH";

async function nextPosition(sessionId: string): Promise<number> {
  const last = await prisma.studySessionQuestion.findFirst({
    where: { sessionId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  return (last?.position ?? 0) + 1;
}

/** Generates/reuses a question for the adaptive engine's chosen `action`, falling back to a plain RECALL @ difficulty 1 once if the first attempt is refused (spec §17: no complex remediation chains). */
export async function generateForAction(
  courseId: string,
  userId: string,
  action: NextLearningAction,
  excludeQuestionIds: string[],
  purpose: QuestionGenerationPurpose,
): Promise<Question> {
  const primary = await getOrGenerateQuestion({
    courseId,
    conceptId: action.conceptId,
    type: action.suggestedQuestionType,
    difficulty: action.difficulty,
    userId,
    purpose,
    excludeQuestionIds,
  });
  if (primary) return primary;

  const fallback = await getOrGenerateQuestion({
    courseId,
    conceptId: action.conceptId,
    type: "RECALL",
    difficulty: 1,
    userId,
    purpose,
    excludeQuestionIds,
  });
  if (fallback) return fallback;

  throw new QuestionGenerationFailedError();
}

function isUniqueConstraintError(error: unknown, target: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    Array.isArray(error.meta?.target) &&
    (error.meta.target as string[]).includes(target)
  );
}

const MAX_POSITION_RETRIES = 3;

/**
 * Attaches a question to a session at the next position. Two races are
 * possible now that prefetch can run concurrently with a live request
 * (Phase 17 §10):
 *
 * 1. The same question was already attached to this session (by a
 *    concurrent prefetch call reusing the same existing Question row) — the
 *    `[sessionId, questionId]` unique constraint catches this; we return
 *    the row that's already there instead of erroring, since the desired
 *    end state ("this question is in the session's queue") already holds.
 * 2. Two calls computed the same "next position" before either committed —
 *    the `[sessionId, position]` unique constraint catches this; a short
 *    bounded retry with a freshly recomputed position resolves it.
 */
export async function createSessionQuestion(sessionId: string, questionId: string, reason: string): Promise<StudySessionQuestion> {
  for (let attempt = 1; attempt <= MAX_POSITION_RETRIES; attempt++) {
    const position = await nextPosition(sessionId);
    try {
      return await prisma.studySessionQuestion.create({ data: { sessionId, questionId, position, reason } });
    } catch (error) {
      if (isUniqueConstraintError(error, "questionId")) {
        return prisma.studySessionQuestion.findFirstOrThrow({ where: { sessionId, questionId } });
      }
      if (isUniqueConstraintError(error, "position") && attempt < MAX_POSITION_RETRIES) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Could not assign a position for this session question after retrying.");
}
