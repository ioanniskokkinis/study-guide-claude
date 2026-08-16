import type { ConceptPriority } from "./knowledge-gaps";

/**
 * Deterministic, evidence-grounded per-item explanations (Phase 15 §38) —
 * "Prioritized because your recent accuracy is 48%" must be a real number
 * this codebase actually computed, never an AI guess. This is why a
 * StudyRoadmapItem's `reason` is built here, in plain TypeScript, rather
 * than trusted to the AI's own `priorities[].reason` (the AI-authored text
 * is still used for the roadmap's overall `summary`/weekly narrative, which
 * are explicitly framed as advice, not factual claims).
 */
export function buildItemReason(priority: ConceptPriority, daysUntilDeadline: number | null): string {
  const parts: string[] = [];

  if (priority.recentAccuracy != null) {
    parts.push(`Your recent accuracy on this is ${Math.round(priority.recentAccuracy * 100)}%.`);
  } else if (priority.masteryPercent === 0) {
    parts.push("You haven't studied this yet.");
  } else {
    parts.push(`Current mastery is ${Math.round(priority.masteryPercent * 100)}%.`);
  }

  if (priority.breakdown.block.blocked && priority.breakdown.block.blockingConceptName) {
    parts.push(`${priority.breakdown.block.blockingConceptName} is a weaker prerequisite worth reinforcing alongside this.`);
  } else if (priority.breakdown.prerequisiteImportance >= 0.5) {
    parts.push("Other topics depend on this one, so strengthening it first has outsized value.");
  }

  if (priority.breakdown.forgettingRisk >= 0.4) {
    parts.push("Retention risk is rising since your last review.");
  }

  if (priority.breakdown.goalRelevance >= 0.6 && daysUntilDeadline != null) {
    parts.push(`Directly relevant to your goal, with ${daysUntilDeadline} day${daysUntilDeadline === 1 ? "" : "s"} left.`);
  }

  return parts.join(" ");
}
