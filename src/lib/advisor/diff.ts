import type { StudyRoadmapItemAction } from "@/generated/prisma/client";

/**
 * Deterministic, human-readable roadmap change summary (Phase 16 §27) —
 * never a raw database diff. Compares only *active* (not-yet-completed,
 * non-milestone) items by conceptId between the roadmap version being
 * replaced and the new one; completed work is handled separately (carried
 * forward, never "removed" — see roadmap-service.ts).
 */
export interface DiffableItem {
  conceptId: string | null;
  title: string;
  estimatedMinutes: number;
  scheduledDate: Date | null;
  action: StudyRoadmapItemAction;
  isMilestone: boolean;
  status?: string;
}

export interface RoadmapChangeSummary {
  removed: string[];
  movedEarlier: string[];
  added: string[];
}

const ACTION_LABEL: Record<StudyRoadmapItemAction, string> = {
  LEARN: "learning",
  REVIEW: "review",
  PRACTICE: "practice",
  ACTIVE_RECALL: "active recall",
  SPACED_REPETITION: "spaced repetition",
  TUTOR: "tutor session",
  EXAM_PRACTICE: "exam practice",
};

function describe(item: DiffableItem): string {
  return `${item.estimatedMinutes} min ${item.title} ${ACTION_LABEL[item.action]}`;
}

export function computeRoadmapDiff(oldItems: DiffableItem[], newItems: DiffableItem[]): RoadmapChangeSummary {
  const oldActive = oldItems.filter((i) => !i.isMilestone && i.status !== "COMPLETED" && i.conceptId);
  const newActive = newItems.filter((i) => !i.isMilestone && i.conceptId);

  const oldByConceptId = new Map<string, DiffableItem>();
  for (const item of oldActive) if (!oldByConceptId.has(item.conceptId!)) oldByConceptId.set(item.conceptId!, item);
  const newByConceptId = new Map<string, DiffableItem>();
  for (const item of newActive) if (!newByConceptId.has(item.conceptId!)) newByConceptId.set(item.conceptId!, item);

  const removed: string[] = [];
  const movedEarlier: string[] = [];

  for (const [conceptId, oldItem] of oldByConceptId) {
    const newItem = newByConceptId.get(conceptId);
    if (!newItem) {
      removed.push(describe(oldItem));
      continue;
    }
    if (oldItem.scheduledDate && newItem.scheduledDate && newItem.scheduledDate.getTime() < oldItem.scheduledDate.getTime()) {
      movedEarlier.push(oldItem.title);
    }
  }

  const added: string[] = [];
  for (const [conceptId, newItem] of newByConceptId) {
    if (!oldByConceptId.has(conceptId)) added.push(describe(newItem));
  }

  return { removed, movedEarlier, added };
}
