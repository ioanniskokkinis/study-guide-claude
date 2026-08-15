import { prisma } from "@/lib/db/prisma";
import { getStudentLearningState } from "@/lib/learning/adaptive/student-state";
import { calculateConceptValue } from "@/lib/learning/adaptive/concept-scoring";
import { bucketForStatus } from "@/lib/services/student-knowledge";
import { selectDifficultyForConcept } from "@/lib/learning/difficulty-engine";
import { RECENT_ATTEMPT_WINDOW, CONVERSATION_HISTORY_WINDOW } from "./config";
import type { ConversationTurn, MisconceptionState, TutorContext, TutorModeValue } from "./types";

/**
 * Builds the TutorContext for one turn (spec §3). Deliberately loads only
 * what this concept/session needs — never the whole course's content — and
 * reuses the Phase 6 AdaptiveLearningEngine's own concept-value calculation
 * for prerequisite-blocking detection rather than re-deriving it (spec §17,
 * §25, §40: "do not duplicate prerequisite scoring").
 *
 * Returns null if the concept doesn't exist or isn't owned by `userId`.
 */
export async function getTutorContext(params: {
  userId: string;
  courseId: string;
  conceptId: string;
  sessionId?: string;
  mode: TutorModeValue;
  latestStudentResponse?: string | null;
}): Promise<TutorContext | null> {
  const concept = await prisma.concept.findFirst({
    where: { id: params.conceptId, courseId: params.courseId, course: { userId: params.userId } },
    select: { id: true, name: true, description: true, difficulty: true },
  });
  if (!concept) return null;

  const [state, mastery, recentMistakes, misconceptions, recentAttempts, goal, currentDifficulty, conversationHistory] =
    await Promise.all([
      getStudentLearningState(params.userId, params.courseId),
      prisma.studentConceptMastery.findUnique({
        where: { userId_conceptId: { userId: params.userId, conceptId: params.conceptId } },
      }),
      prisma.studentMistake.findMany({
        where: { userId: params.userId, conceptId: params.conceptId, resolved: false },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { description: true },
      }),
      prisma.studentMisconception.findMany({
        where: { userId: params.userId, conceptId: params.conceptId, resolved: false },
        orderBy: { lastDetectedAt: "desc" },
      }),
      prisma.learningAttempt.findMany({
        where: { userId: params.userId, conceptId: params.conceptId },
        orderBy: { createdAt: "desc" },
        take: RECENT_ATTEMPT_WINDOW,
        select: { score: true, correctness: true },
      }),
      prisma.learningGoal.findFirst({
        where: { userId: params.userId, courseId: params.courseId, type: "EXAM", targetDate: { not: null } },
        orderBy: { targetDate: "asc" },
        select: { targetDate: true },
      }),
      selectDifficultyForConcept(params.userId, params.conceptId, concept.difficulty),
      params.sessionId ? loadConversationHistory(params.sessionId) : Promise.resolve([]),
    ]);

  const prerequisiteState = state
    ? calculateConceptValue(params.conceptId, state).block
    : { blocked: false, blockingConceptId: null, blockingConceptName: null, blockingMastery: null };

  const now = Date.now();
  const daysUntilExam = goal?.targetDate ? Math.ceil((goal.targetDate.getTime() - now) / (1000 * 60 * 60 * 24)) : null;

  return {
    userId: params.userId,
    courseId: params.courseId,
    conceptId: concept.id,
    conceptName: concept.name,
    conceptDescription: concept.description,
    currentMastery: mastery?.overallMastery ?? 0,
    masteryBucket: bucketForStatus(mastery?.status ?? "UNKNOWN"),
    confidenceScore: mastery?.confidenceScore ?? 0,
    prerequisiteState: {
      blocked: prerequisiteState.blocked,
      blockingConceptId: prerequisiteState.blockingConceptId,
      blockingConceptName: prerequisiteState.blockingConceptName,
      blockingMastery: prerequisiteState.blockingMastery,
    },
    recentMistakeDescriptions: recentMistakes.map((m) => m.description),
    misconceptionState: misconceptions.map(toMisconceptionState),
    recentAttemptScores: recentAttempts.map((a) => a.score ?? a.correctness).filter((v): v is number => v != null),
    learningGoalDaysUntilExam: daysUntilExam,
    currentDifficulty,
    conversationHistory,
    currentActivity: params.mode,
    latestStudentResponse: params.latestStudentResponse ?? null,
  };
}

function toMisconceptionState(m: {
  id: string;
  description: string;
  severity: string;
  confidence: number;
  occurrenceCount: number;
  correctSinceCount: number;
}): MisconceptionState {
  return {
    id: m.id,
    description: m.description,
    severity: m.severity as MisconceptionState["severity"],
    confidence: m.confidence,
    occurrenceCount: m.occurrenceCount,
    correctSinceCount: m.correctSinceCount,
  };
}

async function loadConversationHistory(sessionId: string): Promise<ConversationTurn[]> {
  const messages = await prisma.tutorMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
    take: CONVERSATION_HISTORY_WINDOW,
    select: { role: true, content: true, messageType: true },
  });
  return messages.reverse();
}
