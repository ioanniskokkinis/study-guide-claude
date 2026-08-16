import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { MergedConcept } from "./concept-normalizer";
import type { ValidatedEdge } from "./graph-validator";

export interface AcyclicPrerequisiteEdge {
  prerequisiteName: string;
  dependentName: string;
  confidence: number;
  evidence: string;
  needsReview: boolean;
}

export interface PersistResult {
  conceptsCreated: number;
  relationshipsCreated: number;
  prerequisitesCreated: number;
  lowConfidenceCount: number;
}

export interface PersistConceptsResult {
  conceptsCreated: number;
  /** Concept name -> persisted id, needed by persistRelationships to resolve edge endpoints. */
  nameToId: Map<string, string>;
}

const GENERAL_RELATIONSHIP_TYPES = [
  "contains",
  "related",
  "example_of",
  "contrasts_with",
  "causes",
  "part_of",
  "applies_to",
] as const;

type GeneralRelationshipType = (typeof GENERAL_RELATIONSHIP_TYPES)[number];

function isGeneralRelationshipType(value: string): value is GeneralRelationshipType {
  return (GENERAL_RELATIONSHIP_TYPES as readonly string[]).includes(value);
}

/**
 * Every table that tracks a student's real progress against a specific
 * concept (Phase 2 §R: "Knowledge Graph rebuilds must not delete mastery,
 * learning events, quiz attempts, review history"). `StudentConceptMastery`
 * and `ReviewItem` are handled separately below because they're each
 * unique per (userId, conceptId) — a blind reassignment risks colliding
 * with a row the target concept already has for that user.
 */
async function reassignConceptHistory(tx: Prisma.TransactionClient, fromConceptId: string, toConceptId: string): Promise<void> {
  await tx.knowledgeEvidence.updateMany({ where: { conceptId: fromConceptId }, data: { conceptId: toConceptId } });
  await tx.learningAttempt.updateMany({ where: { conceptId: fromConceptId }, data: { conceptId: toConceptId } });
  await tx.studentMistake.updateMany({ where: { conceptId: fromConceptId }, data: { conceptId: toConceptId } });
  await tx.adaptiveDecisionLog.updateMany({ where: { conceptId: fromConceptId }, data: { conceptId: toConceptId } });
  await tx.tutorSession.updateMany({ where: { conceptId: fromConceptId }, data: { conceptId: toConceptId } });
  await tx.studentMisconception.updateMany({ where: { conceptId: fromConceptId }, data: { conceptId: toConceptId } });
  await tx.question.updateMany({ where: { conceptId: fromConceptId }, data: { conceptId: toConceptId } });
  await tx.examQuestion.updateMany({ where: { conceptId: fromConceptId }, data: { conceptId: toConceptId } });

  // Move only rows for users who don't already have one on the target concept — the target's own
  // existing progress for that user wins rather than being silently clobbered by a unique-constraint
  // conflict. Anything left on `fromConceptId` is lost when it's deleted below (a documented, narrow
  // edge case: the same student had independently-tracked progress on both the old and new identity
  // of what turned out to be "the same" concept).
  const [targetMasteryUsers, orphanMasteries] = await Promise.all([
    tx.studentConceptMastery.findMany({ where: { conceptId: toConceptId }, select: { userId: true } }),
    tx.studentConceptMastery.findMany({ where: { conceptId: fromConceptId }, select: { id: true, userId: true } }),
  ]);
  const targetMasteryUserIds = new Set(targetMasteryUsers.map((m) => m.userId));
  for (const mastery of orphanMasteries) {
    if (!targetMasteryUserIds.has(mastery.userId)) {
      await tx.studentConceptMastery.update({ where: { id: mastery.id }, data: { conceptId: toConceptId } });
    }
  }

  const [targetReviewUsers, orphanReviewItems] = await Promise.all([
    tx.reviewItem.findMany({ where: { conceptId: toConceptId }, select: { userId: true } }),
    tx.reviewItem.findMany({ where: { conceptId: fromConceptId }, select: { id: true, userId: true } }),
  ]);
  const targetReviewUserIds = new Set(targetReviewUsers.map((r) => r.userId));
  for (const item of orphanReviewItems) {
    if (!targetReviewUserIds.has(item.userId)) {
      await tx.reviewItem.update({ where: { id: item.id }, data: { conceptId: toConceptId } });
    }
  }
}

/**
 * Persists the concept layer as a reconciling upsert, matched by
 * `normalizedName` — never a delete-all-then-recreate (Phase 2 §R). A
 * concept that still appears (by normalized name) keeps its database id,
 * so every piece of student history that references it (mastery, evidence,
 * attempts, mistakes, review schedule, tutor sessions, exam questions...)
 * stays intact across a rebuild. Only concepts that genuinely don't
 * reappear are removed, and even then their history is first migrated,
 * best-effort, onto whichever new concept shares the most source material
 * (the AI's own semantic-dedup or re-wording can rename a concept without
 * it being materially a different one) before the row is deleted.
 */
export async function persistConcepts(courseId: string, finalConcepts: MergedConcept[]): Promise<PersistConceptsResult> {
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.concept.findMany({
        where: { courseId },
        select: { id: true, normalizedName: true, sources: { select: { documentChunkId: true } } },
      });
      const existingByNormalizedName = new Map(existing.map((c) => [c.normalizedName, c]));
      const consumedIds = new Set<string>();
      const nameToId = new Map<string, string>();
      const newConceptChunkIds = new Map<string, Set<string>>();

      for (const concept of finalConcepts) {
        const match = existingByNormalizedName.get(concept.normalizedName);
        let conceptId: string;
        if (match) {
          await tx.concept.update({
            where: { id: match.id },
            data: { name: concept.name, description: concept.description, difficulty: concept.difficulty },
          });
          conceptId = match.id;
          consumedIds.add(match.id);
        } else {
          const row = await tx.concept.create({
            data: {
              courseId,
              name: concept.name,
              normalizedName: concept.normalizedName,
              description: concept.description,
              difficulty: concept.difficulty,
            },
          });
          conceptId = row.id;
        }
        nameToId.set(concept.name, conceptId);

        const evidenceByChunk = new Map<string, string>();
        for (const evidence of concept.evidence) {
          if (!evidenceByChunk.has(evidence.chunkId)) {
            evidenceByChunk.set(evidence.chunkId, evidence.text);
          }
        }
        newConceptChunkIds.set(conceptId, new Set(evidenceByChunk.keys()));

        // Sources carry no student history of their own — always safe to fully replace.
        await tx.conceptSource.deleteMany({ where: { conceptId } });
        if (evidenceByChunk.size > 0) {
          await tx.conceptSource.createMany({
            data: [...evidenceByChunk.entries()].map(([documentChunkId, evidence]) => ({ conceptId, documentChunkId, evidence })),
          });
        }
      }

      const orphaned = existing.filter((c) => !consumedIds.has(c.id));
      for (const orphan of orphaned) {
        const orphanChunkIds = new Set(orphan.sources.map((s) => s.documentChunkId));
        let bestId: string | null = null;
        let bestOverlap = 0;
        for (const [conceptId, chunkIds] of newConceptChunkIds) {
          let overlap = 0;
          for (const id of orphanChunkIds) {
            if (chunkIds.has(id)) overlap++;
          }
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestId = conceptId;
          }
        }

        if (bestId) {
          await reassignConceptHistory(tx, orphan.id, bestId);
        }
        await tx.concept.delete({ where: { id: orphan.id } });
      }

      return { conceptsCreated: finalConcepts.length, nameToId };
    },
    { timeout: 30_000 },
  );
}

/**
 * Persists relationship + prerequisite edges against already-persisted
 * concepts (from persistConcepts). Stale edges among this run's surviving
 * concepts are cleared first (relationships carry no student history of
 * their own, so a full replace is safe and correct — unlike concepts
 * themselves); edges belonging to a since-deleted orphan concept are
 * already gone via that concept's own cascading delete. Any edge whose
 * endpoint isn't in `nameToId` is dropped — it must have failed to persist
 * or was filtered out upstream, and a dangling FK is never attempted.
 */
export async function persistRelationships(
  nameToId: Map<string, string>,
  relationshipEdges: ValidatedEdge[],
  acyclicPrerequisites: AcyclicPrerequisiteEdge[],
): Promise<{ relationshipsCreated: number; prerequisitesCreated: number; lowConfidenceCount: number }> {
  const relationshipRows = relationshipEdges
    .filter((edge) => isGeneralRelationshipType(edge.edgeType) && nameToId.has(edge.sourceName) && nameToId.has(edge.targetName))
    .map((edge) => ({
      sourceConceptId: nameToId.get(edge.sourceName) as string,
      targetConceptId: nameToId.get(edge.targetName) as string,
      relationshipType: edge.edgeType as GeneralRelationshipType,
      confidence: edge.confidence,
      evidence: edge.evidence,
      needsReview: edge.needsReview,
    }));

  const prerequisiteRows = acyclicPrerequisites
    .filter((edge) => nameToId.has(edge.prerequisiteName) && nameToId.has(edge.dependentName))
    .map((edge) => ({
      sourceConceptId: nameToId.get(edge.prerequisiteName) as string,
      targetConceptId: nameToId.get(edge.dependentName) as string,
      relationshipType: "prerequisite" as const,
      confidence: edge.confidence,
      evidence: edge.evidence,
      needsReview: edge.needsReview,
    }));

  const conceptIds = [...nameToId.values()];
  const allEdgeRows = [...relationshipRows, ...prerequisiteRows];

  await prisma.$transaction(async (tx) => {
    if (conceptIds.length > 0) {
      await tx.conceptRelationship.deleteMany({
        where: { OR: [{ sourceConceptId: { in: conceptIds } }, { targetConceptId: { in: conceptIds } }] },
      });
    }
    if (allEdgeRows.length > 0) {
      await tx.conceptRelationship.createMany({ data: allEdgeRows });
    }
  });

  return {
    relationshipsCreated: relationshipRows.length,
    prerequisitesCreated: prerequisiteRows.length,
    lowConfidenceCount: allEdgeRows.filter((row) => row.needsReview).length,
  };
}

/**
 * Convenience single-shot path used directly by tests — composes the same
 * history-preserving persistConcepts/persistRelationships the real
 * buildKnowledgeGraph pipeline uses (Phase 2 §R), so there is exactly one
 * implementation of "how concepts get persisted," not two.
 */
export async function persistKnowledgeGraph(
  courseId: string,
  finalConcepts: MergedConcept[],
  relationshipEdges: ValidatedEdge[],
  acyclicPrerequisites: AcyclicPrerequisiteEdge[],
): Promise<PersistResult> {
  const { conceptsCreated, nameToId } = await persistConcepts(courseId, finalConcepts);
  const { relationshipsCreated, prerequisitesCreated, lowConfidenceCount } = await persistRelationships(
    nameToId,
    relationshipEdges,
    acyclicPrerequisites,
  );
  return { conceptsCreated, relationshipsCreated, prerequisitesCreated, lowConfidenceCount };
}
