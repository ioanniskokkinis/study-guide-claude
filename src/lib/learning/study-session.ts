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
import { AI_MAX_TOKENS } from "@/lib/ai/token-budgets";
import { AI_TIMEOUT_MS } from "@/lib/ai/timeout-budgets";
import { buildHintGenerationPrompt, HintGenerationSchema } from "@/lib/ai/prompts/hint-generation";
import { evaluateAnswer, AnswerEvaluationTimeoutError, type AnswerEvaluationResult } from "@/lib/ai/answer-evaluator";
import { bucketForStatus } from "@/lib/services/student-knowledge";
import { recordLearningOutcome, type MistakeInput } from "./record-outcome";
import {
  getNextLearningAction,
  NextLearningActionSchema,
  NoConceptsAvailableError,
  type NextLearningAction,
} from "./adaptive-engine";
import { clampDifficulty, selectDifficultyForConcept } from "./difficulty-engine";
import {
  createSessionQuestion,
  generateForAction,
  QuestionGenerationFailedError,
  type QuestionGenerationPurpose,
} from "./question-serving";
import { ensurePrefetchBuffer, invalidateStaleBufferForConcept } from "./question-prefetch";

export { NoConceptsAvailableError, QuestionGenerationFailedError };

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

export class SessionCompleteError extends Error {
  constructor() {
    super("This session has already reached its target length — complete it to see the summary.");
  }
}

/** A genuine user-input problem (empty/too-long answer, out-of-range confidence) — the one
 * place submitAnswer's validation throws a message that's safe to forward to the client
 * (Phase 19 §19.4), replacing a fragile string-match on plain Error messages. */
export class AnswerValidationError extends Error {}

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

  // Non-blocking (spec §29 — starting a session must never wait on this):
  // top up the buffer beyond the one question just generated synchronously.
  void ensurePrefetchBuffer(session.id, userId).catch(() => {});

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

  void ensurePrefetchBuffer(session.id, userId).catch(() => {});

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

/**
 * Reconstructs the session's current state entirely from persisted rows —
 * safe to call after any page refresh. Prefers the earliest not-yet-
 * answered question (position ascending) over the newest row, since
 * prefetch (Phase 17 §4-6) can mean several unanswered rows already exist
 * ahead of the one the student should actually see next; falls back to the
 * most recent row overall so a refresh right after submitting (before
 * advancing to "next") still shows that answer's feedback instead of
 * nothing. Returns null if not found/owned.
 */
export async function getSessionState(sessionId: string, userId: string): Promise<SessionState | null> {
  const session = await loadOwnedSession(sessionId, userId);
  if (!session) return null;

  const include = { question: { include: { concept: { select: { name: true } } } }, answer: true } as const;
  const currentSessionQuestion =
    (await prisma.studySessionQuestion.findFirst({
      where: { sessionId, answeredAt: null },
      orderBy: { position: "asc" },
      include,
    })) ?? (await prisma.studySessionQuestion.findFirst({ where: { sessionId }, orderBy: { position: "desc" }, include }));

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
  session: StudySession;
  /** The persisted model/expected answer (Phase 17 §7) — always available immediately, never requires a Claude call. */
  modelAnswer: string | null;
  rubric: string[];
}

function normalizeAnswerText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Deterministic fast path (Phase 17 §15): an answer that's an exact, normalized match with the persisted model answer never needs Claude's semantic judgment. Every other case still does — this is a narrow shortcut, not a replacement for evaluation. */
function isExactMatch(answerText: string, expectedAnswer: string | null): boolean {
  if (!expectedAnswer || expectedAnswer.trim().length === 0) return false;
  return normalizeAnswerText(answerText) === normalizeAnswerText(expectedAnswer);
}

async function resolveSourceChunks(sourceReferences: Prisma.JsonValue): Promise<Array<{ id: string; text: string }>> {
  const ids = Array.isArray(sourceReferences) ? (sourceReferences as string[]) : [];
  if (ids.length === 0) return [];
  const chunks = await prisma.documentChunk.findMany({ where: { id: { in: ids } }, select: { id: true, text: true } });
  return chunks;
}

/**
 * Writes a resolved AnswerEvaluationResult onto the Answer row, records the
 * learning outcome (Phase 4) exactly once, and — only when this evaluation
 * actually changed the concept's mastery bucket — invalidates prefetched
 * questions that were generated against the now-stale state (Phase 17
 * §20/§25). Callers (the deterministic fast path and evaluateSubmittedAnswer)
 * are both responsible for their own answeredAt/questionsAnswered bookkeeping
 * — this only ever touches questionsCorrect, never questionsAnswered, so it
 * can't double-count a question the caller already marked answered.
 */
async function settleEvaluation(params: {
  userId: string;
  sessionId: string;
  session: StudySession;
  sessionQuestion: StudySessionQuestion;
  question: Question;
  answer: Answer;
  evaluation: AnswerEvaluationResult;
  normalizedConfidence: number | null;
  durationSeconds: number | null;
}): Promise<{ answer: Answer; session: StudySession }> {
  const { evaluation, question, sessionQuestion } = params;

  const previousMastery = await prisma.studentConceptMastery.findUnique({
    where: { userId_conceptId: { userId: params.userId, conceptId: question.conceptId } },
    select: { status: true },
  });

  const outcome = await recordLearningOutcome({
    userId: params.userId,
    conceptId: question.conceptId,
    activityType: activityTypeForQuestionType(question.type),
    score: evaluation.score,
    confidence: params.normalizedConfidence,
    outcome: evaluation.outcome,
    difficulty: question.difficulty,
    usedHint: sessionQuestion.hintsUsed > 0,
    revealedAnswer: sessionQuestion.revealed,
    durationSeconds: params.durationSeconds,
    mistakes: buildMistakeInputs(evaluation),
    sourceType: "QUESTION",
    notes: evaluation.feedback,
  });
  if (!outcome) throw new SessionNotActiveError();

  const [updatedAnswer, , updatedSession] = await prisma.$transaction([
    prisma.answer.update({
      where: { id: params.answer.id },
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
        evaluationStatus: "COMPLETED",
        evaluationError: null,
      },
    }),
    prisma.studySessionQuestion.update({ where: { id: sessionQuestion.id }, data: { attemptId: outcome.attempt.id } }),
    prisma.studySession.update({
      where: { id: params.session.id },
      data: { questionsCorrect: { increment: evaluation.correctness === "CORRECT" ? 1 : 0 } },
    }),
  ]);

  const previousBucket = previousMastery ? bucketForStatus(previousMastery.status) : "unknown";
  const newBucket = bucketForStatus(outcome.mastery.status);
  if (previousBucket !== newBucket) {
    void invalidateStaleBufferForConcept(params.sessionId, question.conceptId, params.userId).catch(() => {});
  }

  return { answer: updatedAnswer, session: updatedSession };
}

/**
 * Validates the answer belongs to an active session the caller owns and
 * persists it immediately — independent of AI evaluation (Phase 17 §17):
 * this function never calls Claude, so it can never be the reason the UI
 * hangs. `answeredAt`/`questionsAnswered` are finalized right here, not on
 * evaluation success, so the student can always continue even if evaluation
 * never resolves (§38). The response always carries the model answer
 * (already persisted on the Question row — §7) so the UI can show it before
 * evaluation has even started. Never trusts a client-supplied userId; every
 * id is re-verified against the actual session/question ownership chain
 * (spec §36).
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
  if (answerText.length === 0) throw new AnswerValidationError("Answer cannot be empty.");
  if (answerText.length > MAX_ANSWER_LENGTH) throw new AnswerValidationError(`Answer is too long (max ${MAX_ANSWER_LENGTH} characters).`);
  if (input.confidence != null && (input.confidence < 1 || input.confidence > 5)) {
    throw new AnswerValidationError("Confidence must be between 1 and 5.");
  }

  const normalizedConfidence = input.confidence != null ? normalizeConfidence(input.confidence) : null;
  const question = sessionQuestion.question;

  const answer = await prisma.answer.create({
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

  const [, updatedSession] = await prisma.$transaction([
    prisma.studySessionQuestion.update({ where: { id: sessionQuestion.id }, data: { answeredAt: new Date() } }),
    prisma.studySession.update({ where: { id: session.id }, data: { questionsAnswered: { increment: 1 } } }),
  ]);

  let finalAnswer = answer;
  let finalSession = updatedSession;

  if (isExactMatch(answerText, question.expectedAnswer)) {
    const evaluation: AnswerEvaluationResult = {
      score: 1,
      correctness: "CORRECT",
      outcome: "SUCCESS",
      reasoningQuality: 1,
      completeness: 1,
      strengths: [],
      missingPoints: [],
      errors: [],
      misconceptions: [],
      feedback: "Matches the model answer exactly.",
      correctAnswer: question.expectedAnswer ?? "",
      needsRemediation: false,
      prerequisiteGapConceptId: null,
    };
    const settled = await settleEvaluation({
      userId: input.userId,
      sessionId: session.id,
      session: updatedSession,
      sessionQuestion,
      question,
      answer,
      evaluation,
      normalizedConfidence,
      durationSeconds: input.durationSeconds ?? null,
    });
    finalAnswer = settled.answer;
    finalSession = settled.session;
  }

  void ensurePrefetchBuffer(session.id, input.userId).catch(() => {});

  return {
    answer: finalAnswer,
    session: finalSession,
    modelAnswer: question.expectedAnswer,
    rubric: Array.isArray(question.rubric) ? (question.rubric as string[]) : [],
  };
}

export interface EvaluateSubmittedAnswerResult {
  answer: Answer;
  session: StudySession;
}

/**
 * A stale EVALUATING claim (crashed mid-flight, server restart) becomes
 * reclaimable after this long — generous headroom over the Claude call's
 * own timeout so a legitimately in-flight evaluation is never reclaimed
 * out from under itself (Phase 19 §19.6).
 */
const STALE_EVALUATION_CLAIM_MS = env.AI_ACTIVE_RECALL_EVALUATION_TIMEOUT_MS * 2;

/**
 * Atomically claims the right to evaluate `answerId` by transitioning it to
 * EVALUATING, so two concurrent evaluate requests for the same answer (a
 * double-click retry, an overlapping poll) can never both call Claude and
 * recordLearningOutcome() — only one `updateMany` can match the row first
 * (Phase 19 §19.6; ANSWER_EVALUATION and recordLearningOutcome() were
 * otherwise the one place in the app with no DB-level idempotency guard,
 * relying entirely on a read-then-act check with a race window). Returns
 * "claimed" if this call won the race, "already-handled" if another
 * request already owns it (COMPLETED or a still-fresh EVALUATING claim).
 */
async function claimEvaluation(answerId: string): Promise<"claimed" | "already-handled"> {
  const claimed = await prisma.answer.updateMany({
    where: {
      id: answerId,
      OR: [
        { evaluationStatus: { in: ["PENDING", "FAILED", "TIMEOUT"] } },
        { evaluationStatus: "EVALUATING", updatedAt: { lt: new Date(Date.now() - STALE_EVALUATION_CLAIM_MS) } },
      ],
    },
    data: { evaluationStatus: "EVALUATING" },
  });
  return claimed.count > 0 ? "claimed" : "already-handled";
}

/**
 * Runs (or re-runs) Claude evaluation for an already-persisted answer
 * (Phase 17 §13/§18). Idempotent: if this answer's evaluation already
 * COMPLETED — including a deterministic fast-path match from submitAnswer,
 * or a revealed answer — it returns the cached result without calling
 * Claude or recordLearningOutcome() again. A timeout or other failure never
 * throws an HTTP-level error; it settles the answer into a terminal TIMEOUT/
 * FAILED state and returns normally so the UI can offer Retry/Continue
 * without fabricating a CORRECT/INCORRECT outcome (§60).
 */
export async function evaluateSubmittedAnswer(params: {
  sessionId: string;
  userId: string;
  sessionQuestionId: string;
}): Promise<EvaluateSubmittedAnswerResult> {
  const session = await loadOwnedSession(params.sessionId, params.userId);
  if (!session) throw new SessionNotActiveError();

  const sessionQuestion = await prisma.studySessionQuestion.findFirst({
    where: { id: params.sessionQuestionId, sessionId: session.id },
    include: { question: true, answer: true },
  });
  if (!sessionQuestion) throw new SessionNotActiveError();
  const answer = sessionQuestion.answer;
  if (!answer) throw new Error("Submit an answer before requesting evaluation.");

  if (answer.evaluationStatus === "COMPLETED") {
    return { answer, session };
  }

  if ((await claimEvaluation(answer.id)) === "already-handled") {
    const current = await prisma.answer.findUniqueOrThrow({ where: { id: answer.id } });
    return { answer: current, session };
  }

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
      studentAnswer: answer.answerText,
      studentConfidence: answer.confidence,
      userId: params.userId,
    });
  } catch (error) {
    const timedOut = error instanceof AnswerEvaluationTimeoutError;
    const message = timedOut
      ? "We couldn't evaluate your answer in time."
      : error instanceof Error
        ? error.message
        : "Evaluation failed.";
    const updatedAnswer = await prisma.answer.update({
      where: { id: answer.id },
      data: { evaluationError: message, evaluationStatus: timedOut ? "TIMEOUT" : "FAILED" },
    });
    return { answer: updatedAnswer, session };
  }

  const settled = await settleEvaluation({
    userId: params.userId,
    sessionId: session.id,
    session,
    sessionQuestion,
    question,
    answer,
    evaluation,
    normalizedConfidence: answer.confidence,
    durationSeconds: answer.durationSeconds,
  });

  return { answer: settled.answer, session: settled.session };
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
      maxTokens: AI_MAX_TOKENS.HINT,
      requestType: "HINT_GENERATION",
      userId: params.userId,
      timeoutMs: AI_TIMEOUT_MS.HINT,
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
      // No Claude evaluation ever runs for a revealed answer (§21) — it's
      // terminal from the moment it's created, so a retry/evaluate call
      // against this sessionQuestion is a correctly-idempotent no-op.
      evaluationStatus: "COMPLETED",
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
  /** Null when served from the prefetch buffer (Phase 17 §22) — no fresh adaptive-engine decision was made for this specific serve, the one that generated the buffered question already ran and was logged at prefetch time. */
  action: NextLearningAction | null;
  /** Dev-visible signal only (Phase 17 §45) — not used by the current UI. */
  source: "BUFFER" | "GENERATED";
}

/** Development-only diagnostics (Phase 17 §45) — never the student's answer text or any other private content. */
function logActiveRecallTelemetry(params: { sessionId: string; questionSource: "READY_DB" | "GENERATED"; prefetched: boolean }): void {
  if (process.env.NODE_ENV === "production") return;
  console.log(`[ACTIVE_RECALL] session=${params.sessionId} questionSource=${params.questionSource} prefetched=${params.prefetched}`);
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

  // Instant path (Phase 17 §22-23): a "Try Again" always bypasses the
  // buffer (it wants a fresh, engine-bypassing retry action on purpose —
  // spec §17), but a normal "next" first checks for an already-prefetched,
  // ready question before ever considering generation.
  if (!params.retry) {
    const buffered = await prisma.studySessionQuestion.findFirst({
      where: { sessionId: session.id, answeredAt: null },
      orderBy: { position: "asc" },
      include: { question: { include: { concept: { select: { name: true } } } } },
    });
    if (buffered) {
      void ensurePrefetchBuffer(session.id, params.userId).catch(() => {});
      logActiveRecallTelemetry({ sessionId: session.id, questionSource: "READY_DB", prefetched: true });
      return { sessionQuestion: buffered, action: null, source: "BUFFER" };
    }
  }

  // Buffer empty (or an explicit retry) — fall back to on-demand
  // generation exactly as before prefetching existed.
  const previous = await prisma.studySessionQuestion.findFirst({
    where: { sessionId: session.id, answeredAt: { not: null } },
    orderBy: { position: "desc" },
    include: { question: true, answer: true },
  });

  const askedQuestionIds = (
    await prisma.studySessionQuestion.findMany({ where: { sessionId: session.id }, select: { questionId: true } })
  ).map((q) => q.questionId);

  let action: NextLearningAction;
  let purpose: QuestionGenerationPurpose = "QUESTION_GENERATION";

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

  void ensurePrefetchBuffer(session.id, params.userId).catch(() => {});
  logActiveRecallTelemetry({ sessionId: session.id, questionSource: "GENERATED", prefetched: false });

  return {
    sessionQuestion: { ...sessionQuestion, question: { ...question, concept: { name: action.conceptName } } },
    action,
    source: "GENERATED",
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
  if (error instanceof AnswerValidationError) return { status: 400, message: error.message };
  console.error("Study session operation failed:", error);
  return { status: 500, message: "Something went wrong. Please try again." };
}
