import type { AdvisorPromptInput, AdvisorPriorityInput } from "@/lib/ai/prompts/study-advisor";
import type { KnowledgeGapSummary } from "./knowledge-gaps";
import type { TimeBudget } from "./time-budget";

/**
 * Builds the compact, deterministic context handed to the Study Advisor AI
 * call (Phase 15 §26) — goal, deadline, time budget, scope label, mastery
 * summary, and a capped, ranked priority list. Never the underlying
 * document text, chunks, or the student's full learning history — only the
 * already-aggregated numbers `analyzeKnowledgeGaps`/`calculateTimeBudget`
 * produced. This is what keeps token cost/latency bounded regardless of
 * how large the course or the student's history actually is (spec §26).
 */
const MAX_PRIORITIES_IN_CONTEXT = 20;

export interface BuildAdvisorContextParams {
  courseTitle: string;
  goal: string;
  targetScore: number | null;
  deadline: Date | null;
  scopeLabel: string;
  minutesPerDay: number;
  timeBudget: TimeBudget;
  gaps: KnowledgeGapSummary;
  replanContext?: { overdueCount: number; completedCount: number };
}

export function buildAdvisorContext(params: BuildAdvisorContextParams): AdvisorPromptInput {
  const priorities: AdvisorPriorityInput[] = params.gaps.priorities.slice(0, MAX_PRIORITIES_IN_CONTEXT).map((p) => ({
    conceptId: p.conceptId,
    conceptName: p.conceptName,
    masteryPercent: p.masteryPercent,
    recentAccuracy: p.recentAccuracy,
    weakness: p.breakdown.weakness,
    forgettingRisk: p.breakdown.forgettingRisk,
    prerequisiteImportance: p.breakdown.prerequisiteImportance,
    goalRelevance: p.breakdown.goalRelevance,
    value: p.breakdown.value,
    blockedByConceptName: p.breakdown.block.blocked ? p.breakdown.block.blockingConceptName : null,
  }));

  return {
    courseTitle: params.courseTitle,
    goal: params.goal,
    targetScore: params.targetScore,
    deadline: params.deadline,
    scopeLabel: params.scopeLabel,
    minutesPerDay: params.minutesPerDay,
    totalStudyDays: params.timeBudget.totalStudyDays,
    totalMinutes: params.timeBudget.totalMinutes,
    numberOfWeeks: Math.max(1, params.timeBudget.weeks.length),
    overallMasteryPercent: params.gaps.overallMasteryPercent,
    weakConceptCount: params.gaps.weakConceptCount,
    developingConceptCount: params.gaps.developingConceptCount,
    strongConceptCount: params.gaps.strongConceptCount,
    unknownConceptCount: params.gaps.unknownConceptCount,
    priorities,
    replanContext: params.replanContext,
  };
}
