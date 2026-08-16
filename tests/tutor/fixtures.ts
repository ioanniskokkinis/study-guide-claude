import type { SessionBookkeeping } from "@/lib/tutor/decision-support";
import type { ResponseEvaluation, TeachBackEvaluation, TutorContext } from "@/lib/tutor/types";

export function buildContext(overrides: Partial<TutorContext> = {}): TutorContext {
  return {
    userId: "user-1",
    courseId: "course-1",
    conceptId: "concept-1",
    conceptName: "Firewalls",
    conceptDescription: "Devices that filter network traffic.",
    currentMastery: 0.4,
    masteryBucket: "developing",
    confidenceScore: 0.5,
    prerequisiteState: { blocked: false, blockingConceptId: null, blockingConceptName: null, blockingMastery: null },
    recentMistakeDescriptions: [],
    misconceptionState: [],
    recentAttemptScores: [],
    learningGoalDaysUntilExam: null,
    currentDifficulty: 2,
    conversationHistory: [],
    conversationSummary: null,
    currentActivity: "SOCRATIC",
    latestStudentResponse: null,
    ...overrides,
  };
}

export function buildBookkeeping(overrides: Partial<SessionBookkeeping> = {}): SessionBookkeeping {
  return {
    mode: "SOCRATIC",
    socraticDepth: 0,
    hintLevel: 0,
    difficulty: 2,
    consecutiveCorrect: 0,
    consecutiveIncorrect: 0,
    answerRevealed: false,
    lastExplanationStrategy: null,
    lastAction: null,
    ...overrides,
  };
}

export function buildEvaluation(overrides: Partial<ResponseEvaluation> = {}): ResponseEvaluation {
  return {
    classification: "CORRECT",
    confidence: 0.8,
    misconceptionDescription: null,
    severity: null,
    missingConcepts: [],
    recommendedAction: "ASK_FOLLOWUP",
    feedback: "Good.",
    ...overrides,
  };
}

export function buildTeachBackEvaluation(overrides: Partial<TeachBackEvaluation> = {}): TeachBackEvaluation {
  return {
    overall: "CORRECT",
    correctElements: ["core idea"],
    missingElements: [],
    misconceptions: [],
    correctness: 0.9,
    completeness: 0.9,
    conceptualAccuracy: 0.9,
    suggestedFollowup: "Now try a transfer question.",
    ...overrides,
  };
}
