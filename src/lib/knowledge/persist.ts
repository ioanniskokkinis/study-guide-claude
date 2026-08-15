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
 * Atomically replaces a course's entire knowledge graph: deletes existing
 * concepts (cascading to their sources/relationships) and recreates
 * everything from the given validated data, in one transaction. This is
 * what makes buildKnowledgeGraph idempotent (spec §17) — rerunning it with
 * the same inputs always leaves exactly the same rows, never duplicates,
 * because the previous graph is atomically swapped out rather than merged
 * into.
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
