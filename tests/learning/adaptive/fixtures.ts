import type { MistakeSeverity, StudentMistakeCategory } from "@/generated/prisma/client";
import type { ConceptMasterySummary, MasteryBucket } from "@/lib/services/student-knowledge";
import type {
  ConceptNode,
  LearningGoalInfo,
  RecentAttemptInfo,
  RecentMistakeInfo,
  StudentLearningState,
} from "@/lib/learning/adaptive/student-state";

function statusForBucket(bucket: MasteryBucket): ConceptMasterySummary["status"] {
  switch (bucket) {
    case "unknown":
      return "UNKNOWN";
    case "weak":
      return "LEARNING";
    case "developing":
      return "DEVELOPING";
    case "strong":
      return "STRONG";
  }
}

export function mastery(overrides: Partial<ConceptMasterySummary> & { overallMastery: number }): ConceptMasterySummary {
  const bucket: MasteryBucket = overrides.overallMastery >= 0.7 ? "strong" : overrides.overallMastery >= 0.5 ? "developing" : overrides.overallMastery > 0 ? "weak" : "unknown";
  return {
    conceptId: "concept",
    conceptName: "Concept",
    status: statusForBucket(bucket),
    recallScore: overrides.overallMastery,
    explanationScore: overrides.overallMastery,
    applicationScore: overrides.overallMastery,
    transferScore: overrides.overallMastery,
    confidenceScore: 0.5,
    exposureCount: overrides.overallMastery > 0 ? 3 : 0,
    attemptCount: overrides.overallMastery > 0 ? 3 : 0,
    successCount: 0,
    failureCount: 0,
    hintCount: 0,
    revealCount: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    ...overrides,
  };
}

export function concept(id: string, name: string, difficulty = 2): ConceptNode {
  return { id, name, difficulty };
}

export function attempt(overrides: Partial<RecentAttemptInfo> & { conceptId: string }): RecentAttemptInfo {
  return {
    id: `attempt-${Math.random()}`,
    score: 0.5,
    correctness: null,
    difficulty: 2,
    createdAt: new Date(),
    ...overrides,
  };
}

export function mistake(overrides: Partial<RecentMistakeInfo> & { conceptId: string }): RecentMistakeInfo {
  return {
    id: `mistake-${Math.random()}`,
    category: "CONCEPTUAL_GAP" as StudentMistakeCategory,
    severity: "MEDIUM" as MistakeSeverity,
    createdAt: new Date(),
    ...overrides,
  };
}

export function goal(overrides: Partial<LearningGoalInfo> & { type: LearningGoalInfo["type"] }): LearningGoalInfo {
  return {
    id: `goal-${Math.random()}`,
    targetDate: null,
    targetConceptIds: null,
    ...overrides,
  };
}

export function buildState(overrides: Partial<StudentLearningState> = {}): StudentLearningState {
  return {
    userId: "user-1",
    courseId: "course-1",
    concepts: [],
    masteryByConceptId: new Map(),
    recentAttemptsByConceptId: new Map(),
    recentMistakesByConceptId: new Map(),
    prerequisitesByTarget: new Map(),
    goals: [],
    lastActivityAt: null,
    recentlyPracticedConceptIds: [],
    ...overrides,
  };
}
