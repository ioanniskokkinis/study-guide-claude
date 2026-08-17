import { describe, expect, it } from "vitest";
import { TutorEngine, type TutorSessionSnapshot } from "@/lib/tutor/tutor-engine";
import type { ResponseEvaluation, TutorContext } from "@/lib/tutor/types";
import type { TurnEvaluation } from "@/lib/tutor/decision-support";

/**
 * Phase 19 §19.11 — TutorEngine is the actual public entry point
 * tutor-orchestrator.ts calls (`TutorEngine.decide`), not decideNextAction
 * directly (which tutor-decision.test.ts already exercises thoroughly for
 * the deeper branching logic). This proves the TutorSessionSnapshot ->
 * SessionBookkeeping bridge is wired correctly and that a couple of real
 * decisions flow through unchanged, so a future refactor of the bridge
 * itself is caught even though the branching logic is covered elsewhere.
 */
function baseCtx(overrides: Partial<TutorContext> = {}): TutorContext {
  return {
    userId: "user-1",
    courseId: "course-1",
    conceptId: "concept-1",
    conceptName: "Photosynthesis",
    conceptDescription: "How plants convert light into chemical energy.",
    currentMastery: 0.3,
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

function baseSession(overrides: Partial<TutorSessionSnapshot> = {}): TutorSessionSnapshot {
  return {
    mode: "SOCRATIC",
    socraticDepth: 0,
    hintLevel: 0,
    difficulty: 2,
    consecutiveCorrect: 0,
    consecutiveIncorrect: 0,
    answerRevealed: false,
    lastExplanationStrategy: null,
    currentStep: null,
    ...overrides,
  };
}

function responseTurn(overrides: Partial<ResponseEvaluation> = {}): TurnEvaluation {
  return {
    kind: "response",
    selfReportedConfidence: null,
    data: {
      classification: "PARTIALLY_CORRECT",
      confidence: 0.6,
      misconceptionDescription: null,
      severity: null,
      missingConcepts: [],
      recommendedAction: "ASK_FOLLOWUP",
      feedback: "Good start.",
      ...overrides,
    },
  };
}

describe("TutorEngine.decide", () => {
  it("opens a fresh session with a first action when there's no turn yet", () => {
    const result = TutorEngine.decide({
      ctx: baseCtx(),
      session: baseSession(),
      turn: null,
      explicitDontKnow: false,
      explicitRevealRequest: false,
    });

    expect(result.decision.mode).toBe("SOCRATIC");
    expect(result.decision.conceptId).toBe("concept-1");
    expect(typeof result.decision.action).toBe("string");
  });

  it("threads the session snapshot into bookkeeping, and bookkeeping.lastAction always matches the decision just made", () => {
    const result = TutorEngine.decide({
      ctx: baseCtx(),
      session: baseSession({ socraticDepth: 2, hintLevel: 1, consecutiveCorrect: 3, lastExplanationStrategy: "analogy" }),
      turn: null,
      explicitDontKnow: false,
      explicitRevealRequest: false,
    });

    expect(result.bookkeeping.lastAction).toBe(result.decision.action);
  });

  it("an explicit 'I don't know' after a turn gives a hint rather than continuing to ask questions", () => {
    const result = TutorEngine.decide({
      ctx: baseCtx(),
      session: baseSession({ hintLevel: 0 }),
      turn: responseTurn(),
      explicitDontKnow: true,
      explicitRevealRequest: false,
    });

    expect(result.decision.action).toBe("GIVE_HINT");
    expect(result.bookkeeping.hintLevel).toBeGreaterThan(0);
  });

  it("an explicit reveal request always gives the explanation directly and marks the answer revealed", () => {
    const result = TutorEngine.decide({
      ctx: baseCtx(),
      session: baseSession(),
      turn: responseTurn(),
      explicitDontKnow: false,
      explicitRevealRequest: true,
    });

    expect(result.decision.action).toBe("GIVE_EXPLANATION");
    expect(result.bookkeeping.answerRevealed).toBe(true);
  });
});
