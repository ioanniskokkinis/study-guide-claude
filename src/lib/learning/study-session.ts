import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import type {
  Answer,
  LearningActivityType,
  Prisma,
  Question,
  QuestionType,
  StudySession,
  StudySessionQuestion,
} from "@/generated/prisma/client";
import { extractStructured } from "@/lib/ai/claude";
import { withRetry } from "@/lib/ai/retry";
import { buildHintGenerationPrompt, HintGenerationSchema } from "@/lib/ai/prompts/hint-generation";
import { evaluateAnswer, type AnswerEvaluationResult } from "@/lib/ai/answer-evaluator";
import { recordLearningOutcome, type MistakeInput } from "./record-outcome";
import {
  getNextLearningAction,
  NextLearningActionSchema,
  NoConceptsAvailableError,
  type NextLearningAction,
} from "./adaptive-engine";
import { getOrGenerateQuestion } from "./question-generator";
import { clampDifficulty, selectDifficultyForConcept } from "./difficulty-engine";

export { NoConceptsAvailableError };

// ---------------------------------------------------------------------------
// Errors — business-rule violations, distinct from "not found/not owned"
// (those return null, matching the established service convention).
// ---------------------------------------------------------------------------

export class SessionNotActiveError extends Error {
  constructor() {
    super("This study session is no longer active.");
  }
}

export class QuestionAlreadyAnsweredError extends Error {
  constructor() {
    super("This question has already been answered.");
  }
}

export class QuestionGenerationFailedError extends Error {
  constructor() {
    super("Could not generate a question right now. Please try again.");
  }
}

export class SessionCompleteError extends Error {
  constructor() {
    super("This session has already reached its target length — complete it to see the summary.");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** COMPARE has no dedicated LearningActivityType — explaining a distinction is closest in spirit to EXPLANATION. */
function activityTypeForQuestionType(type: QuestionType): LearningActivityType {
  switch (type) {
    case "RECALL":
      return "RECALL";
    case "EXPLAIN":
    case "COMPARE":
      return "EXPLANATION";
    case "APPLY":
      return "APPLICATION";
    case "TRANSFER":
      return "TRANSFER";
  }
}

/** Raw 1-5 self-report -> normalized 0-1, matching Phase 4's confidence representation. */
function normalizeConfidence(raw: number): number {
  return Math.min(1, Math.max(0, (raw - 1) / 4));
}

function buildMistakeInputs(evaluation: AnswerEvaluationResult): MistakeInput[] {
  return [
    ...evaluation.errors.map((e) => ({ category: e.category, description: e.description, severity: e.severity })),
    ...evaluation.misconceptions.map((m) => ({
      category: "MISCONCEPTION" as const,
      description: m.description,
      severity: m.severity,
    })),
  ];
}

async function loadOwnedSession(sessionId: string, userId: string): Promise<StudySession | null> {
  return prisma.studySession.findFirst({ where: { id: sessionId, userId } });
}

async function nextPosition(sessionId: string): Promise<number> {
  const last = await prisma.studySessionQuestion.findFirst({
    where: { sessionId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  return (last?.position ?? 0) + 1;
}

/** Generates/reuses a question for the adaptive engine's chosen `action`, falling back to a plain RECALL @ difficulty 1 once if the first attempt is refused (spec §17: no complex remediation chains). */
async function generateForAction(
  courseId: string,
  userId: string,
  action: NextLearningAction,
  excludeQuestionIds: string[],
  purpose: "QUESTION_GENERATION" | "REMEDIATION",
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

async function createSessionQuestion(sessionId: string, questionId: string, reason: string): Promise<StudySessionQuestion> {
  const position = await nextPosition(sessionId);
  return prisma.studySessionQuestion.create({ data: { sessionId, questionId, position, reason } });
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export interface SessionState {
  session: StudySession;
  currentSessionQuestion:
    | (StudySessionQuestion & { question: Question & { concept: { name: string } }; answer: Answer | null })
    | null;
  targetLength: number;
}

/** Resumes an existing ACTIVE session for this user/course if one exists, otherwise starts a new one (spec §21 — survives refresh rather than always restarting). */
export async function getOrStartSession(userId: string, courseId: string): Promise<SessionState | null> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId } });
  if (!course) return null;

  const existing = await prisma.studySession.findFirst({
    where: { userId, courseId, status: "ACTIVE" },
    orderBy: { startedAt: "desc" },
  });
  if (existing) {
    return getSessionState(existing.id, userId);
  }

  const { action } = await getNextLearningAction({ userId, courseId });

  // Generate the first question BEFORE creating the session row: if
  // generation fails (e.g. a transient Claude error), we must not leave an
  // orphaned ACTIVE session with zero questions behind — getOrStartSession
  // would then "resume" that broken session forever instead of letting the
  // student retry cleanly.
  const question = await generateForAction(courseId, userId, action, [], "QUESTION_GENERATION");

  const session = await prisma.studySession.create({
    data: { userId, courseId, targetLength: env.DEFAULT_RECALL_SESSION_LENGTH },
  });
  await createSessionQuestion(session.id, question.id, action.reason.message);

  return getSessionState(session.id, userId);
}

/**
 * "Study something else" (spec §30-31): starts a session on a
 * student-chosen concept instead of the adaptive engine's recommendation.
 * Bypasses the engine entirely rather than forcing it to justify the
 * override — the recommendation was already shown and logged separately
 * by the caller of getNextLearningAction(); this never punishes or blocks
 * the override. Returns null if the course or concept isn't found/owned.
 */
export async function startSessionForConcept(userId: string, courseId: string, conceptId: string): Promise<SessionState | null> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId } });
  if (!course) return null;

  const existing = await prisma.studySession.findFirst({
    where: { userId, courseId, status: "ACTIVE" },
    orderBy: { startedAt: "desc" },
  });
  if (existing) return getSessionState(existing.id, userId);

  const concept = await prisma.concept.findFirst({
    where: { id: conceptId, courseId },
    select: { id: true, name: true, difficulty: true },
  });
  if (!concept) return null;

  const difficulty = await selectDifficultyForConcept(userId, concept.id, concept.difficulty);
  const action = NextLearningActionSchema.parse({
    actionType: "ACTIVE_RECALL",
    conceptId: concept.id,
    conceptName: concept.name,
    priority: 1,
    difficulty,
    suggestedQuestionType: "RECALL",
    reason: { type: "GENERAL", message: `You chose to study ${concept.name} instead of the suggested concept.` },
    factors: [],
    estimatedDurationMinutes: 5,
  });

  const question = await generateForAction(courseId, userId, action, [], "QUESTION_GENERATION");
  const session = await prisma.studySession.create({
    data: { userId, courseId, targetLength: env.DEFAULT_RECALL_SESSION_LENGTH },
  });
  await createSessionQuestion(session.id, question.id, action.reason.message);

  return getSessionState(session.id, userId);
}

/** Lightweight existence check (no AI calls) — lets the UI silently resume an in-progress session on page load without prompting "Start" again. Returns null if the course doesn't exist/isn't owned, or there's no active session. */
export async function getActiveSessionId(userId: string, courseId: string): Promise<string | null> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId }, select: { id: true } });
  if (!course) return null;

  const session = await prisma.studySession.findFirst({
    where: { userId, courseId, status: "ACTIVE" },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  return session?.id ?? null;
}

/** Reconstructs the session's current state entirely from persisted rows — safe to call after any page refresh. Returns null if not found/owned. */
export async function getSessionState(sessionId: string, userId: string): Promise<SessionState | null> {
  const session = await loadOwnedSession(sessionId, userId);
  if (!session) return null;

  const currentSessionQuestion = await prisma.studySessionQuestion.findFirst({
    where: { sessionId },
    orderBy: { position: "desc" },
    include: { question: { include: { concept: { select: { name: true } } } }, answer: true },
  });

  return { session, currentSessionQuestion, targetLength: session.targetLength };
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

const MAX_ANSWER_LENGTH = 4000;

export interface SubmitAnswerInput {
  sessionId: string;
  userId: string;
  sessionQuestionId: string;
  answerText: string;
  /** Raw 1-5 self-report from the UI. */
  confidence?: number | null;
  durationSeconds?: number | null;
}

export interface SubmitAnswerResult {
  answer: Answer;
  evaluation: AnswerEvaluationResult;
  session: StudySession;
}

/**
 * Validates the answer belongs to an active session the caller owns,
 * persists it immediately (so nothing is lost if evaluation fails — spec
 * §37), evaluates it with Claude, and — only on evaluation success — routes
 * the result through recordLearningOutcome() (Phase 4) to update mastery.
 * Never trusts a client-supplied userId; every id is re-verified against
 * the actual session/question ownership chain (spec §36).
 */
export async function submitAnswer(input: SubmitAnswerInput): Promise<SubmitAnswerResult> {
  const session = await loadOwnedSession(input.sessionId, input.userId);
  if (!session) throw new SessionNotActiveError();
  if (session.status !== "ACTIVE") throw new SessionNotActiveError();

  const sessionQuestion = await prisma.studySessionQuestion.findFirst({
    where: { id: input.sessionQuestionId, sessionId: session.id },
    include: { question: true },
  });
  if (!sessionQuestion) throw new SessionNotActiveError();
  if (sessionQuestion.answeredAt) throw new QuestionAlreadyAnsweredError();

  const answerText = input.answerText.trim();
  if (answerText.length === 0) throw new Error("Answer cannot be empty.");
  if (answerText.length > MAX_ANSWER_LENGTH) throw new Error(`Answer is too long (max ${MAX_ANSWER_LENGTH} characters).`);
  if (input.confidence != null && (input.confidence < 1 || input.confidence > 5)) {
    throw new Error("Confidence must be between 1 and 5.");
  }

  const normalizedConfidence = input.confidence != null ? normalizeConfidence(input.confidence) : null;

  // Persist the raw submission first — evaluation failure below must never
  // lose it. If a previous attempt on this question already failed
  // evaluation, update that row instead of creating a second one: the
  // unique constraint on sessionQuestionId means a second create() here
  // would throw, and this is exactly the retry path spec §37 asks for.
  const pending = await prisma.answer.findUnique({ where: { sessionQuestionId: sessionQuestion.id } });
  const answer = pending
    ? await prisma.answer.update({
        where: { id: pending.id },
        data: {
          answerText,
          confidence: normalizedConfidence,
          usedHint: sessionQuestion.hintsUsed > 0,
          revealedAnswer: sessionQuestion.revealed,
          durationSeconds: input.durationSeconds ?? null,
          evaluationError: null,
        },
      })
    : await prisma.answer.create({
        data: {
          questionId: sessionQuestion.questionId,
          userId: input.userId,
          sessionQuestionId: sessionQuestion.id,
          answerText,
          confidence: normalizedConfidence,
          usedHint: sessionQuestion.hintsUsed > 0,
          revealedAnswer: sessionQuestion.revealed,
          durationSeconds: input.durationSeconds ?? null,
        },
      });

  const question = sessionQuestion.question;
  const concept = await prisma.concept.findUniqueOrThrow({ where: { id: question.conceptId } });

  const [sourceChunks, prerequisiteEdges] = await Promise.all([
    resolveSourceChunks(question.sourceReferences),
    prisma.conceptRelationship.findMany({
      where: { relationshipType: "prerequisite", targetConceptId: question.conceptId },
      select: { sourceConceptId: true, sourceConcept: { select: { name: true } } },
    }),
  ]);

  let evaluation: AnswerEvaluationResult;
  try {
    evaluation = await evaluateAnswer({
      conceptName: concept.name,
      conceptDescription: concept.description ?? "(no description recorded)",
      questionPrompt: question.prompt,
      questionType: question.type,
      expectedAnswer: question.expectedAnswer,
      rubric: Array.isArray(question.rubric) ? (question.rubric as string[]) : [],
      sourceChunks,
      knownPrerequisites: prerequisiteEdges.map((e) => ({ id: e.sourceConceptId, name: e.sourceConcept.name })),
      studentAnswer: answerText,
      studentConfidence: normalizedConfidence,
      userId: input.userId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Evaluation failed.";
    await prisma.answer.update({ where: { id: answer.id }, data: { evaluationError: message } });
    throw new Error("We couldn't evaluate this answer right now. Your answer has been saved. Please try again.");
  }

  const outcome = await recordLearningOutcome({
    userId: input.userId,
    conceptId: question.conceptId,
    activityType: activityTypeForQuestionType(question.type),
    score: evaluation.score,
    confidence: normalizedConfidence,
    outcome: evaluation.outcome,
    difficulty: question.difficulty,
    usedHint: sessionQuestion.hintsUsed > 0,
    revealedAnswer: sessionQuestion.revealed,
    durationSeconds: input.durationSeconds ?? null,
    mistakes: buildMistakeInputs(evaluation),
    sourceType: "QUESTION",
    notes: evaluation.feedback,
  });
  if (!outcome) throw new SessionNotActiveError();

  const [updatedAnswer, , updatedSession] = await prisma.$transaction([
    prisma.answer.update({
      where: { id: answer.id },
      data: {
        score: evaluation.score,
        correctness: evaluation.outcome,
        reasoningQuality: evaluation.reasoningQuality,
        completeness: evaluation.completeness,
        strengths: evaluation.strengths,
        missingPoints: evaluation.missingPoints,
        errors: evaluation.errors as unknown as Prisma.InputJsonValue,
        misconceptions: evaluation.misconceptions as unknown as Prisma.InputJsonValue,
        feedback: evaluation.feedback,
        correctAnswer: evaluation.correctAnswer,
        needsRemediation: evaluation.needsRemediation,
        prerequisiteGapConceptId: evaluation.prerequisiteGapConceptId,
        attemptId: outcome.attempt.id,
      },
    }),
    prisma.studySessionQuestion.update({
      where: { id: sessionQuestion.id },
      data: { answeredAt: new Date(), attemptId: outcome.attempt.id },
    }),
    prisma.studySession.update({
      where: { id: session.id },
      data: {
        questionsAnswered: { increment: 1 },
        questionsCorrect: { increment: evaluation.correctness === "CORRECT" ? 1 : 0 },
      },
    }),
  ]);

  return { answer: updatedAnswer, evaluation, session: updatedSession };
}

async function resolveSourceChunks(sourceReferences: Prisma.JsonValue): Promise<Array<{ id: string; text: string }>> {
  const ids = Array.isArray(sourceReferences) ? (sourceReferences as string[]) : [];
  if (ids.length === 0) return [];
  const chunks = await prisma.documentChunk.findMany({ where: { id: { in: ids } }, select: { id: true, text: true } });
  return chunks;
}

// ---------------------------------------------------------------------------
// Hint / reveal
// ---------------------------------------------------------------------------

export async function requestHint(params: {
  sessionId: string;
  userId: string;
  sessionQuestionId: string;
}): Promise<{ hint: string; hintsUsed: number }> {
  const session = await loadOwnedSession(params.sessionId, params.userId);
  if (!session || session.status !== "ACTIVE") throw new SessionNotActiveError();

  const sessionQuestion = await prisma.studySessionQuestion.findFirst({
    where: { id: params.sessionQuestionId, sessionId: session.id },
    include: { question: { include: { concept: true } } },
  });
  if (!sessionQuestion) throw new SessionNotActiveError();
  if (sessionQuestion.answeredAt) throw new QuestionAlreadyAnsweredError();

  const { system, prompt } = buildHintGenerationPrompt({
    conceptName: sessionQuestion.question.concept.name,
    conceptDescription: sessionQuestion.question.concept.description ?? "(no description recorded)",
    questionPrompt: sessionQuestion.question.prompt,
    rubric: Array.isArray(sessionQuestion.question.rubric) ? (sessionQuestion.question.rubric as string[]) : [],
  });

  const { data } = await withRetry(() =>
    extractStructured({
      model: env.AI_MODEL_HINT_GENERATION,
      system,
      prompt,
      schema: HintGenerationSchema,
      requestType: "HINT_GENERATION",
      userId: params.userId,
    }),
  );

  const updated = await prisma.studySessionQuestion.update({
    where: { id: sessionQuestion.id },
    data: { hintsUsed: { increment: 1 } },
  });

  return { hint: data.hint, hintsUsed: updated.hintsUsed };
}

export interface RevealAnswerResult {
  correctAnswer: string;
  session: StudySession;
}

/**
 * Reveals the answer without going through AI evaluation (there's no
 * student answer to evaluate) and immediately settles this question slot
 * with a zero-credit FAILURE outcome — a revealed answer must never count
 * as a successful retrieval (spec §19).
 */
export async function revealAnswer(params: {
  sessionId: string;
  userId: string;
  sessionQuestionId: string;
}): Promise<RevealAnswerResult> {
  const session = await loadOwnedSession(params.sessionId, params.userId);
  if (!session || session.status !== "ACTIVE") throw new SessionNotActiveError();

  const sessionQuestion = await prisma.studySessionQuestion.findFirst({
    where: { id: params.sessionQuestionId, sessionId: session.id },
    include: { question: true },
  });
  if (!sessionQuestion) throw new SessionNotActiveError();
  if (sessionQuestion.answeredAt) throw new QuestionAlreadyAnsweredError();

  const question = sessionQuestion.question;

  const outcome = await recordLearningOutcome({
    userId: params.userId,
    conceptId: question.conceptId,
    activityType: activityTypeForQuestionType(question.type),
    score: 0,
    outcome: "FAILURE",
    difficulty: question.difficulty,
    usedHint: sessionQuestion.hintsUsed > 0,
    revealedAnswer: true,
    sourceType: "QUESTION",
    notes: "Answer revealed without attempting a retrieval.",
  });
  if (!outcome) throw new SessionNotActiveError();

  await prisma.answer.create({
    data: {
      questionId: question.id,
      userId: params.userId,
      sessionQuestionId: sessionQuestion.id,
      answerText: "",
      score: 0,
      correctness: "FAILURE",
      usedHint: sessionQuestion.hintsUsed > 0,
      revealedAnswer: true,
      feedback: "You revealed the answer instead of attempting retrieval.",
      correctAnswer: question.expectedAnswer,
      attemptId: outcome.attempt.id,
    },
  });

  const [, updatedSession] = await prisma.$transaction([
    prisma.studySessionQuestion.update({
      where: { id: sessionQuestion.id },
      data: { revealed: true, answeredAt: new Date(), attemptId: outcome.attempt.id },
    }),
    prisma.studySession.update({
      where: { id: session.id },
      data: { questionsAnswered: { increment: 1 } },
    }),
  ]);

  return { correctAnswer: question.expectedAnswer ?? "(no reference answer recorded)", session: updatedSession };
}

// ---------------------------------------------------------------------------
// Next question
// ---------------------------------------------------------------------------

export interface NextQuestionResult {
  sessionQuestion: StudySessionQuestion & { question: Question & { concept: { name: string } } };
  action: NextLearningAction;
}

/** Builds a direct, engine-bypassing retry action (spec §17) — "Try Again" is a user override of the recommendation, not a fresh adaptive decision, so it never touches AdaptiveDecisionLog. */
async function buildRetryAction(
  courseId: string,
  previousConceptId: string,
  previousDifficulty: number,
  prerequisiteGapConceptId: string | null,
): Promise<NextLearningAction> {
  const targetConceptId = prerequisiteGapConceptId ?? previousConceptId;
  const concept = await prisma.concept.findFirstOrThrow({
    where: { id: targetConceptId, courseId },
    select: { name: true },
  });

  const action: NextLearningAction = prerequisiteGapConceptId
    ? {
        actionType: "PREREQUISITE_REVIEW",
        conceptId: prerequisiteGapConceptId,
        conceptName: concept.name,
        priority: 1,
        difficulty: 2,
        suggestedQuestionType: "RECALL",
        reason: {
          type: "PREREQUISITE_GAP",
          message: `Your last answer suggested a gap in ${concept.name}, a prerequisite for the concept you were working on.`,
        },
        factors: [],
        estimatedDurationMinutes: 5,
      }
    : {
        actionType: "REMEDIATION",
        conceptId: previousConceptId,
        conceptName: concept.name,
        priority: 1,
        difficulty: clampDifficulty(previousDifficulty - 1),
        suggestedQuestionType: "RECALL",
        reason: { type: "GENERAL", message: `Let's try a more focused, easier question on ${concept.name}.` },
        factors: [],
        estimatedDurationMinutes: 5,
      };

  return NextLearningActionSchema.parse(action);
}

/**
 * Selects and generates the next question, reacting to the previous answer
 * (spec §29, Phase 6 spec §33-36): a fresh, non-retry "next" always defers
 * to the adaptive engine — it re-derives prerequisite gaps, weak concepts,
 * forgetting risk etc. from current mastery data on every call, so it does
 * not need the previous answer's one-off AI-flagged gap to redirect
 * correctly (that signal already feeds mastery/mistakes, which the engine
 * reads). "Try Again" is different: it's an explicit user request to redo
 * *this* concept, easier — that bypasses the engine entirely (spec §17).
 */
export async function nextQuestion(params: {
  sessionId: string;
  userId: string;
  retry?: boolean;
}): Promise<NextQuestionResult> {
  const session = await loadOwnedSession(params.sessionId, params.userId);
  if (!session || session.status !== "ACTIVE") throw new SessionNotActiveError();
  if (session.questionsAnswered >= session.targetLength) throw new SessionCompleteError();

  const previous = await prisma.studySessionQuestion.findFirst({
    where: { sessionId: session.id },
    orderBy: { position: "desc" },
    include: { question: true, answer: true },
  });
  if (previous && !previous.answeredAt) throw new Error("Answer the current question before requesting the next one.");

  const askedQuestionIds = (
    await prisma.studySessionQuestion.findMany({ where: { sessionId: session.id }, select: { questionId: true } })
  ).map((q) => q.questionId);

  let action: NextLearningAction;
  let purpose: "QUESTION_GENERATION" | "REMEDIATION" = "QUESTION_GENERATION";

  if (params.retry && previous) {
    purpose = "REMEDIATION";
    action = await buildRetryAction(
      session.courseId,
      previous.question.conceptId,
      previous.question.difficulty,
      previous.answer?.prerequisiteGapConceptId ?? null,
    );
  } else {
    action = (await getNextLearningAction({ userId: params.userId, courseId: session.courseId })).action;
  }

  const question = await generateForAction(session.courseId, params.userId, action, askedQuestionIds, purpose);
  const sessionQuestion = await createSessionQuestion(session.id, question.id, action.reason.message);

  return {
    sessionQuestion: { ...sessionQuestion, question: { ...question, concept: { name: action.conceptName } } },
    action,
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface SessionSummary {
  session: StudySession;
  questionsAnswered: number;
  questionsCorrect: number;
  averageScore: number;
  conceptsPracticed: string[];
  weakAreas: string[];
  mistakeCount: number;
}

async function buildSessionSummary(session: StudySession): Promise<SessionSummary> {
  const sessionQuestions = await prisma.studySessionQuestion.findMany({
    where: { sessionId: session.id },
    include: { question: { include: { concept: true } }, answer: true },
  });

  const scored = sessionQuestions.map((sq) => sq.answer?.score).filter((s): s is number => s != null);
  const averageScore = scored.length > 0 ? scored.reduce((sum, s) => sum + s, 0) / scored.length : 0;

  const conceptIds = [...new Set(sessionQuestions.map((sq) => sq.question.conceptId))];
  const conceptsPracticed = [...new Set(sessionQuestions.map((sq) => sq.question.concept.name))];

  const attemptIds = sessionQuestions.map((sq) => sq.attemptId).filter((id): id is string => id != null);

  const [weakMasteries, mistakeCount] = await Promise.all([
    conceptIds.length > 0
      ? prisma.studentConceptMastery.findMany({
          where: {
            userId: session.userId,
            conceptId: { in: conceptIds },
            status: { in: ["LEARNING", "NEEDS_REMEDIATION"] },
          },
          include: { concept: { select: { name: true } } },
        })
      : Promise.resolve([]),
    attemptIds.length > 0 ? prisma.studentMistake.count({ where: { attemptId: { in: attemptIds } } }) : Promise.resolve(0),
  ]);

  return {
    session,
    questionsAnswered: session.questionsAnswered,
    questionsCorrect: session.questionsCorrect,
    averageScore,
    conceptsPracticed,
    // Current standing, not "you failed these" — a session doesn't declare mastery either way (spec §28).
    weakAreas: weakMasteries.map((m) => m.concept.name),
    mistakeCount,
  };
}

export async function completeSession(sessionId: string, userId: string): Promise<SessionSummary | null> {
  const session = await loadOwnedSession(sessionId, userId);
  if (!session) return null;

  const updated =
    session.status === "ACTIVE"
      ? await prisma.studySession.update({
          where: { id: session.id },
          data: { status: "COMPLETED", completedAt: new Date() },
        })
      : session;

  return buildSessionSummary(updated);
}

export async function getSessionSummary(sessionId: string, userId: string): Promise<SessionSummary | null> {
  const session = await loadOwnedSession(sessionId, userId);
  if (!session) return null;
  return buildSessionSummary(session);
}

// ---------------------------------------------------------------------------
// Shared HTTP error mapping (used by every route under /api/study-sessions)
// ---------------------------------------------------------------------------

export function studySessionErrorStatus(error: unknown): { status: number; message: string } {
  if (error instanceof NoConceptsAvailableError) return { status: 422, message: error.message };
  if (error instanceof SessionNotActiveError) return { status: 409, message: error.message };
  if (error instanceof QuestionAlreadyAnsweredError) return { status: 409, message: error.message };
  if (error instanceof SessionCompleteError) return { status: 409, message: error.message };
  if (error instanceof QuestionGenerationFailedError) return { status: 502, message: error.message };
  if (error instanceof Error && error.message.startsWith("We couldn't evaluate")) {
    return { status: 502, message: error.message };
  }
  if (error instanceof Error && (error.message.includes("Answer") || error.message.includes("Confidence"))) {
    return { status: 400, message: error.message };
  }
  console.error("Study session operation failed:", error);
  return { status: 500, message: "Something went wrong. Please try again." };
}
