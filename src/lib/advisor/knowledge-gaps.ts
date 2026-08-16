import { bucketForStatus } from "@/lib/services/student-knowledge";
import { calculateConceptScores } from "@/lib/learning/adaptive-engine";
import { getStudentLearningState, type StudentLearningState } from "@/lib/learning/adaptive/student-state";
import type { ConceptValueBreakdown } from "@/lib/learning/adaptive/concept-scoring";

/**
 * Study Advisor knowledge-gap analysis (Phase 15 §24-25). Deliberately NOT
 * a new scoring formula — reuses Phase 6's `getStudentLearningState()` /
 * `calculateConceptScores()` exactly as the adaptive engine does, then
 * filters the result down to the requested scope (spec §11: "the Advisor
 * must only use knowledge derived from the selected scope"). Prerequisite
 * awareness (spec §25) is a byproduct of reusing the same scoring: a weak
 * concept blocked by a weaker prerequisite already surfaces
 * `block.blockingConceptId` from `calculateConceptValue()`, exactly what
 * `findPrerequisiteBlock()` computes for the adaptive engine's own
 * PREREQUISITE_REVIEW candidates.
 */

export class NoScopedConceptsError extends Error {
  constructor() {
    super("No concepts from the selected study material could be found — build or rebuild this course's knowledge graph first.");
  }
}

export interface ConceptPriority {
  conceptId: string;
  conceptName: string;
  breakdown: ConceptValueBreakdown;
  /** 0-1 current mastery — 0 for a never-attempted concept (spec §32: "unknown" is never presented as "weak," but the roadmap still needs a number to rank on). */
  masteryPercent: number;
  /** 0-1 average correctness across the concept's most recent attempts, or null if there is no attempt history yet — the exact number an item's deterministic `reason` text can safely quote (spec §38). */
  recentAccuracy: number | null;
}

export interface KnowledgeGapSummary {
  priorities: ConceptPriority[];
  weakConceptCount: number;
  developingConceptCount: number;
  strongConceptCount: number;
  unknownConceptCount: number;
  overallMasteryPercent: number;
}

const RECENT_ACCURACY_WINDOW = 5;

function calculateRecentAccuracy(conceptId: string, state: StudentLearningState): number | null {
  const attempts = (state.recentAttemptsByConceptId.get(conceptId) ?? []).slice(0, RECENT_ACCURACY_WINDOW);
  const scored = attempts.map((a) => a.correctness ?? a.score).filter((v): v is number => v != null);
  if (scored.length === 0) return null;
  return scored.reduce((sum, v) => sum + v, 0) / scored.length;
}

/**
 * Scores every concept the student has in `courseId` (full-course state is
 * needed for accurate prerequisite-chain reachability — spec §25 — even
 * when a prerequisite itself falls outside the roadmap's material scope),
 * then returns only the ones in `conceptIds`, ranked highest-value first.
 * Throws NoScopedConceptsError if `conceptIds` is empty or matches nothing
 * in this student's course concepts (spec §51 — never fabricate a gap
 * analysis from no data).
 */
export async function analyzeKnowledgeGaps(userId: string, courseId: string, conceptIds: string[]): Promise<KnowledgeGapSummary> {
  const state = await getStudentLearningState(userId, courseId);
  if (!state || conceptIds.length === 0) throw new NoScopedConceptsError();

  const scopedIdSet = new Set(conceptIds);
  const scopedConcepts = state.concepts.filter((c) => scopedIdSet.has(c.id));
  if (scopedConcepts.length === 0) throw new NoScopedConceptsError();

  const scores = calculateConceptScores(state);

  const priorities: ConceptPriority[] = scopedConcepts
    .map((concept) => {
      const breakdown = scores.get(concept.id);
      if (!breakdown) return null;
      const mastery = state.masteryByConceptId.get(concept.id);
      const entry: ConceptPriority = {
        conceptId: concept.id,
        conceptName: concept.name,
        breakdown,
        masteryPercent: mastery?.overallMastery ?? 0,
        recentAccuracy: calculateRecentAccuracy(concept.id, state),
      };
      return entry;
    })
    .filter((p): p is ConceptPriority => p !== null)
    .sort((a, b) => b.breakdown.value - a.breakdown.value);

  let weak = 0;
  let developing = 0;
  let strong = 0;
  let unknown = 0;
  let masterySum = 0;
  let masteryCount = 0;

  for (const concept of scopedConcepts) {
    const mastery = state.masteryByConceptId.get(concept.id);
    const bucket = bucketForStatus(mastery?.status ?? "UNKNOWN");
    if (bucket === "weak") weak++;
    else if (bucket === "developing") developing++;
    else if (bucket === "strong") strong++;
    else unknown++;

    if (mastery && mastery.exposureCount > 0) {
      masterySum += mastery.overallMastery;
      masteryCount++;
    }
  }

  return {
    priorities,
    weakConceptCount: weak,
    developingConceptCount: developing,
    strongConceptCount: strong,
    unknownConceptCount: unknown,
    overallMasteryPercent: masteryCount > 0 ? masterySum / masteryCount : 0,
  };
}
