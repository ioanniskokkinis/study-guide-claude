import { prisma } from "@/lib/db/prisma";
import type { LearningActivityType, Prisma, TutorMessage, TutorSession } from "@/generated/prisma/client";
import { getMastery, bucketForStatus } from "@/lib/services/student-knowledge";
import { recordLearningOutcome, type MistakeInput } from "@/lib/learning/record-outcome";
import { getTutorContext } from "./tutor-state";
import { applyHintDiscount } from "./hints";
import { recordIndependentCorrectEvidence, recordMisconceptionDetection } from "./misconceptions";
import { TutorEngine, type TutorSessionSnapshot } from "./tutor-engine";
import {
  detectExplicitDontKnow,
  detectExplicitRevealRequest,
  evaluateStudentResponse,
  evaluateTeachBack,
  generateExplanation,
  generateHint,
  generateSocraticMessage,
  resolveSourceCitations,
} from "./tutor-evaluator";
import { pickExplanationStrategy, type DecisionResult, type SessionBookkeeping, type TurnEvaluation } from "./decision-support";
import { scoreTeachBack } from "./teach-back";
import { teachBackPromptText, type ConceptFacts } from "./tutor-prompts";
import type {
  ConfidenceLevel,
  ExplanationContent,
  ResponseClassification,
  ResponseEvaluation,
  TeachBackEvaluation,
  TutorContext,
  TutorDecision,
  TutorModeValue,
} from "./types";

/**
 * The full tutor pipeline (spec §39): load state -> evaluate the student's
 * latest response -> update evidence -> consult the deterministic
 * TutorEngine (which itself consults the Phase 6 AdaptiveLearningEngine for
 * prerequisite blocking) -> call Claude for the decided action's language
 * -> validate -> persist -> return. Claude is only ever called to (a)
 * classify a response/teach-back attempt or (b) generate the language for
 * an already-decided action — never to decide what happens (spec §4-5).
 */

export class TutorSessionNotFoundError extends Error {
  constructor() {
    super("Tutor session not found.");
  }
}

export class TutorSessionNotActiveError extends Error {
  constructor() {
    super("This tutoring session is no longer active.");
  }
}

export class ConceptNotFoundError extends Error {
  constructor() {
    super("Concept not found or not owned by this user.");
  }
}

const MAX_MESSAGE_LENGTH = 4000;

export interface TutorTurnResult {
  session: TutorSession;
  message: TutorMessage;
}

function toSnapshot(session: TutorSession): TutorSessionSnapshot {
  return {
    mode: session.mode,
    socraticDepth: session.socraticDepth,
    hintLevel: session.hintLevel,
    difficulty: session.difficulty,
    consecutiveCorrect: session.consecutiveCorrect,
    consecutiveIncorrect: session.consecutiveIncorrect,
    answerRevealed: session.answerRevealed,
    lastExplanationStrategy: session.lastExplanationStrategy,
    currentStep: session.currentStep,
  };
}

function toConceptFacts(ctx: TutorContext): ConceptFacts {
  return {
    conceptName: ctx.conceptName,
    conceptDescription: ctx.conceptDescription,
    masteryBucket: ctx.masteryBucket,
    recentMistakeDescriptions: ctx.recentMistakeDescriptions,
    conversationHistory: ctx.conversationHistory.map((t) => ({ role: t.role, content: t.content })),
  };
}

async function loadConceptFacts(
  conceptId: string,
  userId: string,
  conversationHistory: ConceptFacts["conversationHistory"],
): Promise<ConceptFacts> {
  const [concept, mastery] = await Promise.all([
    prisma.concept.findUnique({ where: { id: conceptId }, select: { name: true, description: true } }),
    getMastery(userId, conceptId),
  ]);
  return {
    conceptName: concept?.name ?? "this concept",
    conceptDescription: concept?.description ?? null,
    masteryBucket: mastery ? bucketForStatus(mastery.status) : "unknown",
    recentMistakeDescriptions: [],
    conversationHistory,
  };
}

function formatExplanation(explanation: ExplanationContent, sourceChunks: Array<{ citation: string }>): string {
  const parts = [explanation.coreIdea, `For example: ${explanation.example}`, explanation.connection, explanation.checkQuestion];
  if (sourceChunks.length > 0) {
    parts.push(`Source: ${sourceChunks.map((c) => c.citation).join(", ")}`);
  }
  return parts.join("\n\n");
}

function lastTutorMessageContent(history: ConceptFacts["conversationHistory"]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "TUTOR") return history[i].content;
  }
  return "";
}

/** Generates the language for a decided action (spec §5) — the only place besides evaluation that calls Claude. Returns whether a real Claude call was made (spec §54). */
async function generateContent(params: {
  decision: TutorDecision;
  ctx: TutorContext;
  bookkeepingAfter: SessionBookkeeping;
  userId: string;
}): Promise<{ content: string; metadata: Record<string, unknown>; aiCallMade: boolean }> {
  const { decision, ctx, bookkeepingAfter, userId } = params;
  const facts = toConceptFacts(ctx);

  switch (decision.action) {
    case "ASK_QUESTION":
    case "ASK_FOLLOWUP":
    case "DEEPEN":
    case "SIMPLIFY":
    case "DECREASE_DIFFICULTY":
    case "INCREASE_DIFFICULTY": {
      const intent =
        decision.action === "DEEPEN"
          ? "deepen"
          : decision.action === "SIMPLIFY" || decision.action === "DECREASE_DIFFICULTY"
            ? "simplify"
            : decision.action === "ASK_FOLLOWUP"
              ? "followup"
              : "new_question";
      const content = await generateSocraticMessage({ ...facts, intent, difficulty: decision.difficulty, userId });
      return { content, metadata: {}, aiCallMade: true };
    }
    case "GIVE_HINT": {
      const level = Math.min(3, Math.max(1, bookkeepingAfter.hintLevel)) as 1 | 2 | 3;
      const content = await generateHint({ ...facts, level, tutorPrompt: lastTutorMessageContent(facts.conversationHistory), userId });
      return { content, metadata: { hintLevel: level }, aiCallMade: true };
    }
    case "GIVE_EXPLANATION": {
      const revealed = decision.metadata.revealed === true;
      const strategy =
        typeof decision.metadata.explanationStrategy === "string"
          ? decision.metadata.explanationStrategy
          : pickExplanationStrategy(bookkeepingAfter.lastExplanationStrategy);
      const sourceChunks = await resolveSourceCitations(decision.conceptId);
      const explanation = await generateExplanation({ ...facts, strategy, sourceChunks, userId });
      return { content: formatExplanation(explanation, sourceChunks), metadata: { strategy, revealed }, aiCallMade: true };
    }
    case "CHECK_PREREQUISITE": {
      const targetFacts =
        decision.conceptId === ctx.conceptId ? facts : await loadConceptFacts(decision.conceptId, userId, facts.conversationHistory);
      const strategy = pickExplanationStrategy(bookkeepingAfter.lastExplanationStrategy);
      const sourceChunks = await resolveSourceCitations(decision.conceptId);
      const explanation = await generateExplanation({ ...targetFacts, strategy, sourceChunks, userId });
      return { content: formatExplanation(explanation, sourceChunks), metadata: { strategy, redirectedTo: decision.conceptId }, aiCallMade: true };
    }
    case "REMEDIATE": {
      const strategy = pickExplanationStrategy(bookkeepingAfter.lastExplanationStrategy);
      const sourceChunks = await resolveSourceCitations(decision.conceptId);
      const explanation = await generateExplanation({ ...facts, strategy, sourceChunks, userId });
      return { content: formatExplanation(explanation, sourceChunks), metadata: { strategy }, aiCallMade: true };
    }
    case "TEACH_BACK":
      return { content: teachBackPromptText(ctx.conceptName), metadata: {}, aiCallMade: false };
    case "COMPLETE":
      return {
        content: `Nice work — you've shown solid, independent understanding of ${ctx.conceptName}.`,
        metadata: {},
        aiCallMade: false,
      };
  }
}

function scoreForClassification(classification: ResponseClassification): number {
  switch (classification) {
    case "CORRECT":
      return 0.95;
    case "PARTIALLY_CORRECT":
      return 0.55;
    case "INCORRECT":
      return 0.2;
    case "MISCONCEPTION":
      return 0.1;
    case "UNKNOWN":
      return 0.2;
  }
}

function confidenceLevelToScore(level: ConfidenceLevel | null): number | null {
  switch (level) {
    case "CONFIDENT":
      return 0.9;
    case "UNSURE":
      return 0.5;
    case "GUESSING":
      return 0.15;
    default:
      return null;
  }
}

function mistakesForResponseEvaluation(evaluation: ResponseEvaluation): MistakeInput[] {
  if (evaluation.classification === "MISCONCEPTION") {
    return [
      {
        category: "MISCONCEPTION",
        description: evaluation.misconceptionDescription ?? "Misconception detected.",
        severity: evaluation.severity ?? "MEDIUM",
      },
    ];
  }
  if (evaluation.classification === "INCORRECT" && evaluation.missingConcepts.length > 0) {
    return [{ category: "CONCEPTUAL_GAP", description: `Missing: ${evaluation.missingConcepts.join(", ")}`, severity: "MEDIUM" }];
  }
  return [];
}

function mistakesForTeachBack(evaluation: TeachBackEvaluation): MistakeInput[] {
  return evaluation.misconceptions.map((description) => ({ category: "MISCONCEPTION" as const, description, severity: "MEDIUM" as const }));
}

/**
 * Persists one piece of learning evidence for an evaluated turn (spec §24,
 * §47). Explicit "I don't know" / "just tell me" turns never reach this —
 * they aren't answer attempts, so recording them as performance evidence
 * would misrepresent what happened (spec §45-46).
 */
async function recordEvidenceForTurn(params: {
  userId: string;
  conceptId: string;
  bookkeepingBefore: SessionBookkeeping;
  turn: Extract<TurnEvaluation, { kind: "response" | "teachback" }>;
}): Promise<void> {
  const { userId, conceptId, bookkeepingBefore, turn } = params;

  const activityType: LearningActivityType = turn.kind === "teachback" ? "TEACH_BACK" : "RECALL";

  if (turn.kind === "teachback") {
    const score = scoreTeachBack(turn.data);
    await recordLearningOutcome({
      userId,
      conceptId,
      activityType,
      score,
      difficulty: bookkeepingBefore.difficulty,
      usedHint: false,
      revealedAnswer: false,
      mistakes: mistakesForTeachBack(turn.data),
      sourceType: "TEACH_BACK",
      notes: turn.data.suggestedFollowup,
    });
    return;
  }

  const rawScore = scoreForClassification(turn.data.classification);
  // Correct-with-a-hint is weaker evidence than an independent correct answer (spec §24).
  const score = turn.data.classification === "CORRECT" ? applyHintDiscount(rawScore, bookkeepingBefore.hintLevel) : rawScore;

  await recordLearningOutcome({
    userId,
    conceptId,
    activityType,
    score,
    confidence: confidenceLevelToScore(turn.selfReportedConfidence),
    difficulty: bookkeepingBefore.difficulty,
    usedHint: bookkeepingBefore.hintLevel > 0,
    revealedAnswer: false,
    mistakes: mistakesForResponseEvaluation(turn.data),
    sourceType: "QUESTION",
    notes: turn.data.feedback,
  });
}

function readStartMastery(metadata: unknown): number | null {
  if (metadata == null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).startMastery;
  return typeof value === "number" ? value : null;
}

async function persistOutcomeIfCompleting(params: {
  sessionId: string;
  conceptId: string;
  userId: string;
  decision: TutorDecision;
  hintsUsedTotal: number;
  questionsAnswered: number;
  misconceptionResolved: boolean;
  teachBackScore: number | null;
}): Promise<void> {
  if (params.decision.action !== "COMPLETE") return;

  const firstMessage = await prisma.tutorMessage.findFirst({
    where: { sessionId: params.sessionId, role: "TUTOR" },
    orderBy: { createdAt: "asc" },
    select: { metadata: true },
  });
  const startMastery = readStartMastery(firstMessage?.metadata);

  const currentMastery = await getMastery(params.userId, params.conceptId);
  const masteryDelta = startMastery != null && currentMastery ? currentMastery.overallMastery - startMastery : null;

  await prisma.tutorSessionOutcome.create({
    data: {
      sessionId: params.sessionId,
      conceptId: params.conceptId,
      masteryDelta,
      misconceptionResolved: params.misconceptionResolved,
      hintsUsed: params.hintsUsedTotal,
      questionsAnswered: params.questionsAnswered,
      teachBackScore: params.teachBackScore,
    },
  });
}

export interface TutorSessionResult {
  session: TutorSession;
  messages: TutorMessage[];
}

/**
 * Starts a new tutor session on `conceptId` (spec §42), or resumes an
 * already-active one for the same (user, course, concept) so a page
 * refresh or repeat visit continues the same conversation instead of
 * silently spawning a duplicate (spec §20/§31).
 */
export async function startTutorSession(params: {
  userId: string;
  courseId: string;
  conceptId: string;
  mode: TutorModeValue;
}): Promise<TutorSessionResult> {
  const existing = await prisma.tutorSession.findFirst({
    where: { userId: params.userId, courseId: params.courseId, conceptId: params.conceptId, status: "ACTIVE" },
    orderBy: { startedAt: "desc" },
  });
  if (existing) {
    const messages = await prisma.tutorMessage.findMany({ where: { sessionId: existing.id }, orderBy: { createdAt: "asc" } });
    return { session: existing, messages };
  }

  const startMastery = await getMastery(params.userId, params.conceptId);
  const ctx = await getTutorContext({
    userId: params.userId,
    courseId: params.courseId,
    conceptId: params.conceptId,
    mode: params.mode,
  });
  if (!ctx) throw new ConceptNotFoundError();

  const session = await prisma.tutorSession.create({
    data: {
      userId: params.userId,
      courseId: params.courseId,
      conceptId: params.conceptId,
      mode: params.mode,
      difficulty: ctx.currentDifficulty,
    },
  });

  const result = TutorEngine.decide({
    ctx,
    session: toSnapshot(session),
    turn: null,
    explicitDontKnow: false,
    explicitRevealRequest: false,
  });

  const { content, metadata, aiCallMade } = await generateContent({
    decision: result.decision,
    ctx,
    bookkeepingAfter: result.bookkeeping,
    userId: params.userId,
  });

  const [updatedSession, message] = await prisma.$transaction([
    prisma.tutorSession.update({
      where: { id: session.id },
      data: {
        ...bookkeepingToUpdateData(result.bookkeeping, result.decision),
        aiCallCount: aiCallMade ? { increment: 1 } : undefined,
      },
    }),
    prisma.tutorMessage.create({
      data: {
        sessionId: session.id,
        role: "TUTOR",
        content,
        messageType: result.decision.messageType,
        metadata: {
          ...metadata,
          action: result.decision.action,
          reason: result.decision.reason,
          startMastery: startMastery?.overallMastery ?? 0,
        } as Prisma.InputJsonValue,
      },
    }),
  ]);

  return { session: updatedSession, messages: [message] };
}

function bookkeepingToUpdateData(bookkeeping: SessionBookkeeping, decision: TutorDecision) {
  return {
    mode: bookkeeping.mode,
    socraticDepth: bookkeeping.socraticDepth,
    hintLevel: bookkeeping.hintLevel,
    difficulty: bookkeeping.difficulty,
    consecutiveCorrect: bookkeeping.consecutiveCorrect,
    consecutiveIncorrect: bookkeeping.consecutiveIncorrect,
    answerRevealed: bookkeeping.answerRevealed,
    lastExplanationStrategy: bookkeeping.lastExplanationStrategy,
    currentStep: decision.action,
    ...(decision.action === "COMPLETE" ? { status: "COMPLETED" as const, completedAt: new Date() } : {}),
  };
}

async function lastTutorMessageType(sessionId: string) {
  const message = await prisma.tutorMessage.findFirst({
    where: { sessionId, role: "TUTOR" },
    orderBy: { createdAt: "desc" },
    select: { messageType: true },
  });
  return message?.messageType ?? "FEEDBACK";
}

/** Submits the student's next message and returns the tutor's response (spec §39). */
export async function submitTutorMessage(params: {
  sessionId: string;
  userId: string;
  content: string;
  confidence?: ConfidenceLevel | null;
}): Promise<TutorTurnResult> {
  const session = await prisma.tutorSession.findFirst({ where: { id: params.sessionId, userId: params.userId } });
  if (!session) throw new TutorSessionNotFoundError();
  if (session.status !== "ACTIVE") throw new TutorSessionNotActiveError();

  const content = params.content.trim();
  if (content.length === 0) throw new Error("Message cannot be empty.");
  if (content.length > MAX_MESSAGE_LENGTH) throw new Error(`Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`);

  const studentMessageType = await lastTutorMessageType(session.id);
  await prisma.tutorMessage.create({
    data: { sessionId: session.id, role: "STUDENT", content, messageType: studentMessageType },
  });

  const ctx = await getTutorContext({
    userId: params.userId,
    courseId: session.courseId,
    conceptId: session.conceptId,
    sessionId: session.id,
    mode: session.mode,
    latestStudentResponse: content,
  });
  if (!ctx) throw new ConceptNotFoundError();

  const explicitDontKnow = detectExplicitDontKnow(content);
  const explicitRevealRequest = detectExplicitRevealRequest(content);
  const bookkeepingBefore = toSnapshotBookkeeping(session);
  const facts = toConceptFacts(ctx);

  let turn: TurnEvaluation;
  if (explicitDontKnow || explicitRevealRequest) {
    // Explicit-phrase turns never reach Claude or recordLearningOutcome (spec §45-46, §53) — the stub is only a
    // structural placeholder so decideNextAction sees a non-null turn; its `data` is never read for these two flags.
    turn = { kind: "response", data: stubResponseEvaluation(), selfReportedConfidence: params.confidence ?? null };
  } else if (session.mode === "TEACH_BACK") {
    const data = await evaluateTeachBack({ ...facts, studentExplanation: content, userId: params.userId });
    turn = { kind: "teachback", data };
  } else {
    const data = await evaluateStudentResponse({
      ...facts,
      tutorPrompt: lastTutorMessageContent(facts.conversationHistory),
      studentResponse: content,
      userId: params.userId,
    });
    turn = { kind: "response", data, selfReportedConfidence: params.confidence ?? null };
  }

  const result = TutorEngine.decide({
    ctx,
    session: toSnapshot(session),
    turn,
    explicitDontKnow,
    explicitRevealRequest,
  });

  if (!explicitDontKnow && !explicitRevealRequest) {
    await recordEvidenceForTurn({ userId: params.userId, conceptId: ctx.conceptId, bookkeepingBefore, turn });
  }

  let misconceptionResolved = false;
  if (result.misconceptionToRecord) {
    await recordMisconceptionDetection({
      userId: params.userId,
      conceptId: ctx.conceptId,
      description: result.misconceptionToRecord.description,
      severity: result.misconceptionToRecord.severity,
    });
  } else if (result.independentCorrectEvidence) {
    const resolvedIds = await recordIndependentCorrectEvidence(params.userId, ctx.conceptId);
    misconceptionResolved = resolvedIds.length > 0;
  }

  const { content: replyContent, metadata, aiCallMade } = await generateContent({
    decision: result.decision,
    ctx,
    bookkeepingAfter: result.bookkeeping,
    userId: params.userId,
  });

  const teachBackScore = turn.kind === "teachback" ? scoreTeachBack(turn.data) : null;
  const questionsAnswered = session.questionsAnswered + 1;
  const hintsUsedTotal = session.hintsUsedTotal + (result.decision.action === "GIVE_HINT" ? 1 : 0);

  await persistOutcomeIfCompleting({
    sessionId: session.id,
    conceptId: ctx.conceptId,
    userId: params.userId,
    decision: result.decision,
    hintsUsedTotal,
    questionsAnswered,
    misconceptionResolved,
    teachBackScore,
  });

  const [updatedSession, message] = await prisma.$transaction([
    prisma.tutorSession.update({
      where: { id: session.id },
      data: {
        ...bookkeepingToUpdateData(result.bookkeeping, result.decision),
        questionsAnswered,
        hintsUsedTotal,
        aiCallCount: aiCallMade ? { increment: 1 } : undefined,
      },
    }),
    prisma.tutorMessage.create({
      data: {
        sessionId: session.id,
        role: "TUTOR",
        content: replyContent,
        messageType: result.decision.messageType,
        metadata: { ...metadata, action: result.decision.action, reason: result.decision.reason } as Prisma.InputJsonValue,
      },
    }),
  ]);

  return { session: updatedSession, message };
}

function toSnapshotBookkeeping(session: TutorSession): SessionBookkeeping {
  return {
    mode: session.mode,
    socraticDepth: session.socraticDepth,
    hintLevel: session.hintLevel,
    difficulty: session.difficulty,
    consecutiveCorrect: session.consecutiveCorrect,
    consecutiveIncorrect: session.consecutiveIncorrect,
    answerRevealed: session.answerRevealed,
    lastExplanationStrategy: session.lastExplanationStrategy,
    lastAction: session.currentStep,
  };
}

function stubResponseEvaluation(): ResponseEvaluation {
  return {
    classification: "UNKNOWN",
    confidence: 0,
    misconceptionDescription: null,
    severity: null,
    missingConcepts: [],
    recommendedAction: "GIVE_HINT",
    feedback: "",
  };
}

/** Reconstructs the session's current state — safe to call after any page refresh (spec §20 UI resume). */
export async function getTutorSessionState(sessionId: string, userId: string): Promise<TutorSessionResult | null> {
  const session = await prisma.tutorSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) return null;
  const messages = await prisma.tutorMessage.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } });
  return { session, messages };
}

/** Proactive hint request (spec §41 optional endpoint) — the student clicked "Hint" rather than typing "I don't know." */
export async function requestTutorHint(sessionId: string, userId: string): Promise<TutorTurnResult> {
  const session = await prisma.tutorSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new TutorSessionNotFoundError();
  if (session.status !== "ACTIVE") throw new TutorSessionNotActiveError();

  const ctx = await getTutorContext({
    userId,
    courseId: session.courseId,
    conceptId: session.conceptId,
    sessionId: session.id,
    mode: session.mode,
  });
  if (!ctx) throw new ConceptNotFoundError();

  const nextLevel = Math.min(4, session.hintLevel + 1);
  const facts = toConceptFacts(ctx);
  const tutorPrompt = lastTutorMessageContent(facts.conversationHistory);

  let content: string;
  let lastExplanationStrategy = session.lastExplanationStrategy;
  const isReveal = nextLevel >= 4;
  const action = isReveal ? "GIVE_EXPLANATION" : "GIVE_HINT";
  const messageMetadata: Record<string, unknown> = { action };

  if (isReveal) {
    const strategy = pickExplanationStrategy(session.lastExplanationStrategy);
    const sourceChunks = await resolveSourceCitations(session.conceptId);
    const explanation = await generateExplanation({ ...facts, strategy, sourceChunks, userId });
    content = formatExplanation(explanation, sourceChunks);
    lastExplanationStrategy = strategy;
    messageMetadata.strategy = strategy;
    messageMetadata.revealed = true;
  } else {
    const level = nextLevel as 1 | 2 | 3;
    content = await generateHint({ ...facts, level, tutorPrompt, userId });
    messageMetadata.hintLevel = level;
  }

  const [updatedSession, message] = await prisma.$transaction([
    prisma.tutorSession.update({
      where: { id: session.id },
      data: {
        hintLevel: nextLevel,
        answerRevealed: isReveal,
        lastExplanationStrategy,
        currentStep: action,
        hintsUsedTotal: { increment: 1 },
        aiCallCount: { increment: 1 },
      },
    }),
    prisma.tutorMessage.create({
      data: {
        sessionId: session.id,
        role: "TUTOR",
        content,
        messageType: isReveal ? "EXPLANATION" : "HINT",
        metadata: messageMetadata as Prisma.InputJsonValue,
      },
    }),
  ]);

  return { session: updatedSession, message };
}

/** Explicitly switches an in-progress session into TEACH_BACK mode (spec §41 optional endpoint, §48 "remediation -> recall -> teach-back"). */
export async function requestTeachBack(sessionId: string, userId: string): Promise<TutorTurnResult> {
  const session = await prisma.tutorSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new TutorSessionNotFoundError();
  if (session.status !== "ACTIVE") throw new TutorSessionNotActiveError();

  const ctx = await getTutorContext({
    userId,
    courseId: session.courseId,
    conceptId: session.conceptId,
    sessionId: session.id,
    mode: "TEACH_BACK",
  });
  if (!ctx) throw new ConceptNotFoundError();

  const content = teachBackPromptText(ctx.conceptName);

  const [updatedSession, message] = await prisma.$transaction([
    prisma.tutorSession.update({
      where: { id: session.id },
      data: {
        mode: "TEACH_BACK",
        socraticDepth: 0,
        hintLevel: 0,
        answerRevealed: false,
        currentStep: "TEACH_BACK",
      },
    }),
    prisma.tutorMessage.create({
      data: { sessionId: session.id, role: "TUTOR", content, messageType: "TEACH_BACK_PROMPT", metadata: { action: "TEACH_BACK" } },
    }),
  ]);

  return { session: updatedSession, message };
}

export function tutorSessionErrorStatus(error: unknown): { status: number; message: string } {
  if (error instanceof TutorSessionNotFoundError) return { status: 404, message: error.message };
  if (error instanceof TutorSessionNotActiveError) return { status: 409, message: error.message };
  if (error instanceof ConceptNotFoundError) return { status: 404, message: error.message };
  if (error instanceof Error) return { status: 400, message: error.message };
  return { status: 500, message: "Something went wrong." };
}

export type { DecisionResult };
