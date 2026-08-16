import { prisma } from "@/lib/db/prisma";
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
 * Persists only the concept layer (deletes+recreates concepts/sources for
 * this course, same idempotency guarantee as persistKnowledgeGraph). Split
 * out from relationship/prerequisite persistence (production-hardening
 * phase §A7) so a later relationship/prerequisite-extraction failure can
 * never roll back concepts that already succeeded — partial results are
 * kept and shown, never silently discarded.
 */
export async function persistConcepts(courseId: string, finalConcepts: MergedConcept[]): Promise<PersistConceptsResult> {
  return prisma.$transaction(async (tx) => {
    await tx.concept.deleteMany({ where: { courseId } });

    const nameToId = new Map<string, string>();
    for (const concept of finalConcepts) {
      const row = await tx.concept.create({
        data: {
          courseId,
          name: concept.name,
          normalizedName: concept.normalizedName,
          description: concept.description,
          difficulty: concept.difficulty,
        },
      });
      nameToId.set(concept.name, row.id);

      const evidenceByChunk = new Map<string, string>();
      for (const evidence of concept.evidence) {
        if (!evidenceByChunk.has(evidence.chunkId)) {
          evidenceByChunk.set(evidence.chunkId, evidence.text);
        }
      }
      if (evidenceByChunk.size > 0) {
        await tx.conceptSource.createMany({
          data: [...evidenceByChunk.entries()].map(([documentChunkId, evidence]) => ({
            conceptId: row.id,
            documentChunkId,
            evidence,
          })),
        });
      }
    }

    return { conceptsCreated: finalConcepts.length, nameToId };
  });
}

/**
 * Persists relationship + prerequisite edges against already-persisted
 * concepts (from persistConcepts). Any edge whose endpoint isn't in
 * `nameToId` is dropped — it must have failed to persist or was filtered
 * out upstream, and a dangling FK is never attempted.
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

  const allEdgeRows = [...relationshipRows, ...prerequisiteRows];
  if (allEdgeRows.length > 0) {
    await prisma.conceptRelationship.createMany({ data: allEdgeRows });
  }

  return {
    relationshipsCreated: relationshipRows.length,
    prerequisitesCreated: prerequisiteRows.length,
    lowConfidenceCount: allEdgeRows.filter((row) => row.needsReview).length,
  };
}

/**
 * Atomically replaces a course's entire knowledge graph: deletes existing
 * concepts (cascading to their sources/relationships) and recreates
 * everything from the given validated data, in one transaction. This is
 * what makes buildKnowledgeGraph idempotent (spec §17) — rerunning it with
 * the same inputs always leaves exactly the same rows, never duplicates,
 * because the previous graph is atomically swapped out rather than merged
 * into. Kept as the single-shot convenience path (still used directly by
 * existing tests); knowledge-builder.ts's staged pipeline instead calls
 * persistConcepts/persistRelationships separately for partial recovery.
 */
export async function persistKnowledgeGraph(
  courseId: string,
  finalConcepts: MergedConcept[],
  relationshipEdges: ValidatedEdge[],
  acyclicPrerequisites: AcyclicPrerequisiteEdge[],
): Promise<PersistResult> {
  return prisma.$transaction(async (tx) => {
    await tx.concept.deleteMany({ where: { courseId } });

    const nameToId = new Map<string, string>();
    for (const concept of finalConcepts) {
      const row = await tx.concept.create({
        data: {
          courseId,
          name: concept.name,
          normalizedName: concept.normalizedName,
          description: concept.description,
          difficulty: concept.difficulty,
        },
      });
      nameToId.set(concept.name, row.id);

      const evidenceByChunk = new Map<string, string>();
      for (const evidence of concept.evidence) {
        if (!evidenceByChunk.has(evidence.chunkId)) {
          evidenceByChunk.set(evidence.chunkId, evidence.text);
        }
      }
      if (evidenceByChunk.size > 0) {
        await tx.conceptSource.createMany({
          data: [...evidenceByChunk.entries()].map(([documentChunkId, evidence]) => ({
            conceptId: row.id,
            documentChunkId,
            evidence,
          })),
        });
      }
    }

    const relationshipRows = relationshipEdges
      .filter((edge) => isGeneralRelationshipType(edge.edgeType))
      .map((edge) => ({
        sourceConceptId: nameToId.get(edge.sourceName) as string,
        targetConceptId: nameToId.get(edge.targetName) as string,
        relationshipType: edge.edgeType as GeneralRelationshipType,
        confidence: edge.confidence,
        evidence: edge.evidence,
        needsReview: edge.needsReview,
      }));

    const prerequisiteRows = acyclicPrerequisites.map((edge) => ({
      sourceConceptId: nameToId.get(edge.prerequisiteName) as string,
      targetConceptId: nameToId.get(edge.dependentName) as string,
      relationshipType: "prerequisite" as const,
      confidence: edge.confidence,
      evidence: edge.evidence,
      needsReview: edge.needsReview,
    }));

    const allEdgeRows = [...relationshipRows, ...prerequisiteRows];
    if (allEdgeRows.length > 0) {
      await tx.conceptRelationship.createMany({ data: allEdgeRows });
    }

    return {
      conceptsCreated: finalConcepts.length,
      relationshipsCreated: relationshipRows.length,
      prerequisitesCreated: prerequisiteRows.length,
      lowConfidenceCount: [...relationshipRows, ...prerequisiteRows].filter((row) => row.needsReview).length,
    };
  });
}
