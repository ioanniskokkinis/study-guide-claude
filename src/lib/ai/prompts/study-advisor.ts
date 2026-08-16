import { z } from "zod";

/**
 * Phase 15 §27-28 — the AI decides prioritization/sequencing/study
 * strategy/weekly structure/rationale; it never does arithmetic (available
 * time, daily totals) and it never invents facts. Every numeric claim it's
 * allowed to make in a per-concept `reason` must trace to a number already
 * present in the prompt (the priority breakdown below) — see
 * src/lib/advisor/roadmap-generator.ts for the deterministic per-item
 * `reason` text this schema's own `priorities[].reason` field actually
 * feeds into.
 */
export const StudyAdvisorAiOutputSchema = z.object({
  summary: z.string().min(1).max(1200),
  priorities: z
    .array(
      z.object({
        conceptId: z.string().min(1),
        reason: z.string().min(1).max(300),
      }),
    )
    .max(20),
  weeks: z
    .array(
      z.object({
        weekNumber: z.number().int().min(1),
        focusConceptIds: z.array(z.string().min(1)).max(10),
        reason: z.string().min(1).max(500),
      }),
    )
    .max(30),
  milestones: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        afterWeek: z.number().int().min(1),
      }),
    )
    .max(12),
  risks: z.array(z.string().min(1).max(300)).max(8),
  recommendations: z.array(z.string().min(1).max(300)).max(8),
});
export type StudyAdvisorAiOutput = z.infer<typeof StudyAdvisorAiOutputSchema>;

export interface AdvisorPriorityInput {
  conceptId: string;
  conceptName: string;
  masteryPercent: number;
  recentAccuracy: number | null;
  weakness: number;
  forgettingRisk: number;
  prerequisiteImportance: number;
  goalRelevance: number;
  value: number;
  blockedByConceptName: string | null;
  /** Phase 16 §6, §24 — deterministic trend (never AI-inferred) so the AI can reason "declining + important -> raise priority" without recomputing anything itself. */
  trend?: "IMPROVING" | "STABLE" | "DECLINING" | "INSUFFICIENT_DATA";
}

export interface AdvisorPromptInput {
  courseTitle: string;
  goal: string;
  targetScore: number | null;
  deadline: Date | null;
  scopeLabel: string;
  minutesPerDay: number;
  totalStudyDays: number;
  totalMinutes: number;
  numberOfWeeks: number;
  overallMasteryPercent: number;
  weakConceptCount: number;
  developingConceptCount: number;
  strongConceptCount: number;
  unknownConceptCount: number;
  priorities: AdvisorPriorityInput[];
  /** Set only when this generation is a replan (Phase 15 §36-38, extended Phase 16 §7-8) — overdue/completed/missed-minute counts from the roadmap being replaced. */
  replanContext?: { overdueCount: number; completedCount: number; missedMinutes?: number };
}

const SYSTEM_PROMPT = `You are a Study Advisor. You decide WHAT a student should study, in what ORDER, and WHY — never HOW MUCH TIME exists (that has already been calculated for you and is fixed) and never facts about the student's performance (those are given to you as exact numbers).

Rules:
- Only reference concepts by the exact conceptId values given below — never invent a conceptId, and never propose a concept that isn't in the provided list.
- Every "reason" you write must be grounded in the numeric facts given below (mastery percentages, recent accuracy, prerequisite relationships, days until deadline). Do not invent statistics, percentages, or facts not present in the data below.
- You may reference at most ${20} concepts across "priorities", spread across as many "weeks" as make sense within the fixed total minutes given below.
- The total study time across all weeks is fixed at the given number of minutes — do not imply the student should study more or less than that; sequencing and emphasis are your job, not the total.
- Prerequisite concepts should generally be scheduled before the concepts that depend on them.
- If this is a replan (see below), account for already-completed and overdue material honestly — do not pretend nothing has happened yet.
- Return structured JSON only, matching the provided schema. Keep "summary", "risks", and "recommendations" concise and actionable — this is read by a real student, not a report.`;

export function buildStudyAdvisorPrompt(input: AdvisorPromptInput) {
  const deadlineLine = input.deadline
    ? `Deadline: ${input.deadline.toISOString().slice(0, 10)} (${input.numberOfWeeks} week${input.numberOfWeeks === 1 ? "" : "s"} from now)`
    : `Deadline: none set — plan for ${input.numberOfWeeks} week${input.numberOfWeeks === 1 ? "" : "s"} of steady progress.`;

  const priorityBlocks = input.priorities
    .map((p, i) => {
      const accuracy = p.recentAccuracy != null ? `${Math.round(p.recentAccuracy * 100)}%` : "no recent attempts";
      const blocked = p.blockedByConceptName ? ` | blocked by prerequisite: ${p.blockedByConceptName}` : "";
      const trend = p.trend && p.trend !== "INSUFFICIENT_DATA" ? ` | recent trend: ${p.trend.toLowerCase()}` : "";
      return `${i + 1}. conceptId=${p.conceptId} | name="${p.conceptName}" | mastery=${Math.round(p.masteryPercent * 100)}% | recent accuracy=${accuracy} | weakness=${p.weakness.toFixed(2)} | forgetting risk=${p.forgettingRisk.toFixed(2)} | prerequisite importance=${p.prerequisiteImportance.toFixed(2)} | goal relevance=${p.goalRelevance.toFixed(2)} | overall priority value=${p.value.toFixed(2)}${blocked}${trend}`;
    })
    .join("\n");

  const replanLine = input.replanContext
    ? `\nThis is a replan of an existing roadmap: ${input.replanContext.completedCount} item(s) already completed, ${input.replanContext.overdueCount} item(s) overdue${input.replanContext.missedMinutes ? ` (${input.replanContext.missedMinutes} minutes of missed study time)` : ""}. Adjust the plan honestly for the time remaining — redistribute missed material sensibly rather than piling it all onto the very next session.`
    : "";

  const prompt = `Course: ${input.courseTitle}
Study material scope: ${input.scopeLabel}
Student's goal: "${input.goal}"${input.targetScore != null ? `\nTarget score: ${Math.round(input.targetScore * 100)}%` : ""}
${deadlineLine}
Available study time: ${input.minutesPerDay} minutes/day across ${input.totalStudyDays} study day(s) = ${input.totalMinutes} total minutes (FIXED — do not exceed this).
Current knowledge in this scope: ${Math.round(input.overallMasteryPercent * 100)}% average mastery — ${input.weakConceptCount} weak, ${input.developingConceptCount} developing, ${input.strongConceptCount} strong, ${input.unknownConceptCount} not yet attempted.${replanLine}

Concepts ranked by priority (highest value first — this ranking already accounts for weakness, forgetting risk, prerequisites, and goal relevance; you decide sequencing and weekly structure, not whether a concept matters):
${priorityBlocks}

Produce a study roadmap: a short summary, a prioritized subset of the concepts above with a grounded reason each, a week-by-week structure (weekNumber 1..${input.numberOfWeeks}) with which concepts to focus on and why, a few milestones, risks, and recommendations.`;

  return { system: SYSTEM_PROMPT, prompt };
}
