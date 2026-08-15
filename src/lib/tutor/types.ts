import { z } from "zod";

/**
 * Shared vocabulary for the Intelligent Tutor Engine (Phase 7). Mirrors the
 * pattern established by the Phase 6 adaptive engine
 * (src/lib/learning/adaptive/types.ts): plain `as const` arrays double as
 * both the TypeScript union and the Zod enum, and every structured value
 * that crosses the Claude boundary is validated before anything downstream
 * trusts it (spec §35 — never trust arbitrary model output).
 */

export const TUTOR_MODES = ["SOCRATIC", "TEACH_BACK", "REMEDIATION"] as const;
export type TutorModeValue = (typeof TUTOR_MODES)[number];

export const TUTOR_SESSION_STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "ABANDONED"] as const;
export type TutorSessionStatusValue = (typeof TUTOR_SESSION_STATUSES)[number];

/**
 * The full action vocabulary a TutorDecision can carry (spec §4). This is
 * produced by deterministic application logic (tutor-decision.ts /
 * tutor-engine.ts) — Claude never picks this value directly (spec §4-5).
 */
export const TUTOR_DECISION_ACTIONS = [
  "ASK_QUESTION",
  "ASK_FOLLOWUP",
  "GIVE_HINT",
  "GIVE_EXPLANATION",
  "SIMPLIFY",
  "DEEPEN",
  "CHECK_PREREQUISITE",
  "REMEDIATE",
  "TEACH_BACK",
  "INCREASE_DIFFICULTY",
  "DECREASE_DIFFICULTY",
  "COMPLETE",
] as const;
export type TutorDecisionAction = (typeof TUTOR_DECISION_ACTIONS)[number];

export const TUTOR_MESSAGE_ROLES = ["TUTOR", "STUDENT", "SYSTEM"] as const;
export type TutorMessageRoleValue = (typeof TUTOR_MESSAGE_ROLES)[number];

export const TUTOR_MESSAGE_TYPES = [
  "QUESTION",
  "FOLLOWUP",
  "HINT",
  "EXPLANATION",
  "FEEDBACK",
  "TEACH_BACK_PROMPT",
  "REMEDIATION",
  "COMPLETION",
] as const;
export type TutorMessageTypeValue = (typeof TUTOR_MESSAGE_TYPES)[number];

/** How the latest student response was classified (spec §11). Never a boolean. */
export const RESPONSE_CLASSIFICATIONS = ["CORRECT", "PARTIALLY_CORRECT", "INCORRECT", "MISCONCEPTION", "UNKNOWN"] as const;
export type ResponseClassification = (typeof RESPONSE_CLASSIFICATIONS)[number];

/** Optional student self-report (spec §29) — used to detect illusion of competence. */
export const CONFIDENCE_LEVELS = ["CONFIDENT", "UNSURE", "GUESSING"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const HINT_LEVELS = ["HINT_1", "HINT_2", "HINT_3", "REVEAL"] as const;
export type HintLevelLabel = (typeof HINT_LEVELS)[number];

export const EXPLANATION_STRATEGIES = [
  "analogy",
  "example",
  "counterexample",
  "step_by_step",
  "compare_contrast",
] as const;
export type ExplanationStrategy = (typeof EXPLANATION_STRATEGIES)[number];

// ---------------------------------------------------------------------------
// TutorDecision — the engine's structured, validated output (spec §4).
// ---------------------------------------------------------------------------

export const TutorDecisionSchema = z.object({
  action: z.enum(TUTOR_DECISION_ACTIONS),
  conceptId: z.string().min(1),
  difficulty: z.number().int().min(1).max(5),
  /** Concise, user-facing rationale only — never internal prompts or chain-of-thought (spec §33). */
  reason: z.string().min(1).max(300),
  messageType: z.enum(TUTOR_MESSAGE_TYPES),
  /** The mode this decision executes in — may differ from the session's current mode when the decision itself is a transition (e.g. REMEDIATE while mode is still SOCRATIC). */
  mode: z.enum(TUTOR_MODES),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});
export type TutorDecision = z.infer<typeof TutorDecisionSchema>;

// ---------------------------------------------------------------------------
// TutorContext — everything decideNextAction()/mode logic needs to reason
// about a turn. Deliberately narrow (spec §3): only what's needed for this
// concept and this session, never the whole course.
// ---------------------------------------------------------------------------

export interface ConversationTurn {
  role: TutorMessageRoleValue;
  content: string;
  messageType: TutorMessageTypeValue;
}

export interface PrerequisiteBlockState {
  blocked: boolean;
  blockingConceptId: string | null;
  blockingConceptName: string | null;
  blockingMastery: number | null;
}

export interface MisconceptionState {
  id: string;
  description: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  confidence: number;
  occurrenceCount: number;
  correctSinceCount: number;
}

export interface TutorContext {
  userId: string;
  courseId: string;
  conceptId: string;
  conceptName: string;
  conceptDescription: string | null;
  currentMastery: number;
  masteryBucket: "unknown" | "weak" | "developing" | "strong";
  confidenceScore: number;
  prerequisiteState: PrerequisiteBlockState;
  recentMistakeDescriptions: string[];
  misconceptionState: MisconceptionState[];
  recentAttemptScores: number[];
  learningGoalDaysUntilExam: number | null;
  currentDifficulty: number;
  conversationHistory: ConversationTurn[];
  currentActivity: TutorModeValue;
  latestStudentResponse: string | null;
}

// ---------------------------------------------------------------------------
// Claude-facing structured outputs — every field is validated with Zod
// before the application trusts it (spec §35). Descriptions are short,
// concise strings; nothing here is raw chain-of-thought (spec §11, §33).
// ---------------------------------------------------------------------------

export const ResponseEvaluationSchema = z.object({
  classification: z.enum(RESPONSE_CLASSIFICATIONS),
  confidence: z.number().min(0).max(1),
  /** Null unless classification is MISCONCEPTION or the answer reveals a specific gap worth naming. */
  misconceptionDescription: z.string().max(300).nullable(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).nullable(),
  missingConcepts: z.array(z.string().max(120)).max(5),
  /**
   * Claude's suggestion only — informational metadata, never branched on
   * directly (spec §4-5). The deterministic decision layer computes its own
   * action from `classification` + the rest of TutorContext.
   */
  recommendedAction: z.enum(TUTOR_DECISION_ACTIONS),
  feedback: z.string().max(400),
});
export type ResponseEvaluation = z.infer<typeof ResponseEvaluationSchema>;

export const TeachBackEvaluationSchema = z.object({
  overall: z.enum(["CORRECT", "PARTIALLY_CORRECT", "INCORRECT"]),
  correctElements: z.array(z.string().max(150)).max(8),
  missingElements: z.array(z.string().max(150)).max(8),
  misconceptions: z.array(z.string().max(200)).max(5),
  correctness: z.number().min(0).max(1),
  completeness: z.number().min(0).max(1),
  conceptualAccuracy: z.number().min(0).max(1),
  suggestedFollowup: z.string().max(300),
});
export type TeachBackEvaluation = z.infer<typeof TeachBackEvaluationSchema>;

export const ExplanationContentSchema = z.object({
  coreIdea: z.string().max(400),
  example: z.string().max(400),
  connection: z.string().max(300),
  checkQuestion: z.string().max(250),
});
export type ExplanationContent = z.infer<typeof ExplanationContentSchema>;

export const SocraticMessageSchema = z.object({
  message: z.string().min(1).max(400),
});
export type SocraticMessage = z.infer<typeof SocraticMessageSchema>;
