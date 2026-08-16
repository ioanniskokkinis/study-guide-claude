import { prisma } from "@/lib/db/prisma";
import { bucketForStatus, type ConceptMasterySummary } from "@/lib/services/student-knowledge";

/**
 * Deterministic weak-concept ranking (Phase 2 §C). Building on the existing
 * bucket queries in student-knowledge.ts (which already answer "is this
 * concept weak?" in two batched, non-N+1 queries), this adds an ordering —
 * "of everything weak, what's most worth studying first?" — from signals
 * already on hand: how far below mastery it is, how recently it was missed,
 * how much real evidence backs the "weak" label, and how many other
 * concepts it blocks as a prerequisite. No Claude call, no per-concept
 * query — every input is loaded in one small batch of course-scoped
 * queries and joined in memory.
 */

/** Weight for the mastery gap (1 - overallMastery) — the dominant signal: the further from mastered, the higher priority. */
export const WEIGHT_MASTERY_GAP = 0.45;
/** Weight for how recently the student last got this wrong — a fresh miss outranks a stale one at the same mastery level. */
export const WEIGHT_RECENT_STRUGGLE = 0.2;
/** Weight for how many other concepts list this one as a prerequisite — fixing a blocking concept unblocks the most follow-on progress. */
export const WEIGHT_UNLOCK_VALUE = 0.2;
/** Weight for how much attempt evidence actually backs the "weak" label — a single unlucky miss should rank below a concept missed five times. */
export const WEIGHT_EVIDENCE_CONFIDENCE = 0.15;

/** A struggle inside this window counts as "fresh" (factor 1); it decays linearly to 0 by RECENT_STRUGGLE_HORIZON_DAYS. */
const RECENT_STRUGGLE_HORIZON_DAYS = 14;
/** Attempt count at which "this concept is weak" is considered fully evidenced, for score purposes. */
const CONFIDENT_WEAKNESS_ATTEMPT_COUNT = 4;
/** Caps how much unlock value one concept can contribute — beyond this many dependents, more fan-out stops adding priority. */
const MAX_UNLOCK_FANOUT = 5;

export interface RankedWeakConcept {
  conceptId: string;
  conceptName: string;
  mastery: ConceptMasterySummary;
  /** How many other concepts in this course list this one as a prerequisite. */
  unlocksCount: number;
  /** 0-1 composite priority score (higher = study this first). Deterministic, reproducible from the inputs above. */
  score: number;
  /** Short, user-facing factors behind the ranking (spec's "why this?" pattern, mirrored from the adaptive engine). */
  factors: string[];
}

function recentStruggleFactor(lastFailureAt: Date | null, now: Date): number {
  if (!lastFailureAt) return 0;
  const daysSince = (now.getTime() - lastFailureAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince <= 0) return 1;
  if (daysSince >= RECENT_STRUGGLE_HORIZON_DAYS) return 0;
  return 1 - daysSince / RECENT_STRUGGLE_HORIZON_DAYS;
}

/**
 * Ranks every concept in `courseId` currently in the "weak" bucket (spec's
 * LEARNING/NEEDS_REMEDIATION statuses) by deterministic study priority.
 * Returns `[]` for a course with no weak concepts (including a brand-new
 * course with no history) and `null` if the course doesn't exist or isn't
 * owned by `userId` — same not-found convention as the rest of this module.
 */
export async function rankWeakConcepts(
  userId: string,
  courseId: string,
  now: Date = new Date(),
): Promise<RankedWeakConcept[] | null> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId }, select: { id: true } });
  if (!course) return null;

  const concepts = await prisma.concept.findMany({ where: { courseId }, select: { id: true, name: true } });
  if (concepts.length === 0) return [];
  const conceptIds = concepts.map((c) => c.id);

  const [masteries, prerequisiteEdges] = await Promise.all([
    prisma.studentConceptMastery.findMany({ where: { userId, conceptId: { in: conceptIds } } }),
    prisma.conceptRelationship.findMany({
      where: { relationshipType: "prerequisite", sourceConceptId: { in: conceptIds } },
      select: { sourceConceptId: true },
    }),
  ]);
  const masteryByConceptId = new Map(masteries.map((m) => [m.conceptId, m]));

  const unlocksByConceptId = new Map<string, number>();
  for (const edge of prerequisiteEdges) {
    unlocksByConceptId.set(edge.sourceConceptId, (unlocksByConceptId.get(edge.sourceConceptId) ?? 0) + 1);
  }

  const ranked: RankedWeakConcept[] = [];
  for (const concept of concepts) {
    const masteryRow = masteryByConceptId.get(concept.id);
    if (!masteryRow || bucketForStatus(masteryRow.status) !== "weak") continue;

    const masteryGap = 1 - masteryRow.overallMastery;
    const struggle = recentStruggleFactor(masteryRow.lastFailureAt, now);
    const unlocksCount = unlocksByConceptId.get(concept.id) ?? 0;
    const unlockValue = Math.min(unlocksCount / MAX_UNLOCK_FANOUT, 1);
    const evidenceConfidence = Math.min(masteryRow.attemptCount / CONFIDENT_WEAKNESS_ATTEMPT_COUNT, 1);

    const score =
      WEIGHT_MASTERY_GAP * masteryGap +
      WEIGHT_RECENT_STRUGGLE * struggle +
      WEIGHT_UNLOCK_VALUE * unlockValue +
      WEIGHT_EVIDENCE_CONFIDENCE * evidenceConfidence;

    const factors: string[] = [`${Math.round(masteryRow.overallMastery * 100)}% mastery`];
    if (struggle > 0) factors.push("Missed recently");
    if (unlocksCount > 0) factors.push(`Blocks ${unlocksCount} other concept${unlocksCount === 1 ? "" : "s"}`);
    if (evidenceConfidence >= 1) factors.push("Consistently weak across multiple attempts");

    ranked.push({
      conceptId: concept.id,
      conceptName: concept.name,
      mastery: {
        conceptId: concept.id,
        conceptName: concept.name,
        status: masteryRow.status,
        overallMastery: masteryRow.overallMastery,
        recallScore: masteryRow.recallScore,
        explanationScore: masteryRow.explanationScore,
        applicationScore: masteryRow.applicationScore,
        transferScore: masteryRow.transferScore,
        confidenceScore: masteryRow.confidenceScore,
        exposureCount: masteryRow.exposureCount,
        attemptCount: masteryRow.attemptCount,
        successCount: masteryRow.successCount,
        failureCount: masteryRow.failureCount,
        hintCount: masteryRow.hintCount,
        revealCount: masteryRow.revealCount,
        lastAttemptAt: masteryRow.lastAttemptAt,
        lastSuccessAt: masteryRow.lastSuccessAt,
        lastFailureAt: masteryRow.lastFailureAt,
      },
      unlocksCount,
      score,
      factors,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}
