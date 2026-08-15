import { prisma } from "@/lib/db/prisma";
import type { ConceptSummaryInput } from "@/lib/ai/prompts/relationship-extraction";
import { extractConceptsFromChunks } from "./concept-extractor";
import { mergeByNormalizedName, mergeSemanticDuplicates, type MergedConcept } from "./concept-normalizer";
import { extractRelationships } from "./relationship-extractor";
import { extractPrerequisites } from "./prerequisite-analyzer";
import { validateEdges, filterAcyclicPrerequisites } from "./graph-validator";
import { persistKnowledgeGraph } from "./persist";
import { CONCEPT_MERGE_CONFIDENCE_THRESHOLD, EVIDENCE_SNIPPETS_PER_CONCEPT, RELATIONSHIP_CONFIDENCE } from "./config";

export interface KnowledgeBuildSummary {
  conceptsCreated: number;
  conceptsMerged: number;
  relationshipsCreated: number;
  prerequisitesCreated: number;
  lowConfidenceRelationships: number;
  errors: string[];
}

async function loadReadyChunks(courseId: string) {
  return prisma.documentChunk.findMany({
    where: { document: { courseId, processingStatus: "READY" } },
    orderBy: [{ documentId: "asc" }, { chunkIndex: "asc" }],
    select: { id: true, text: true },
  });
}

function toConceptSummaries(concepts: MergedConcept[]): ConceptSummaryInput[] {
  return concepts.map((concept) => ({
    name: concept.name,
    description: concept.description,
    difficulty: concept.difficulty,
    evidenceSnippets: concept.evidence.slice(0, EVIDENCE_SNIPPETS_PER_CONCEPT).map((e) => e.text),
  }));
}

/**
 * Rebuilds a course's knowledge graph from its processed documents:
 * chunks -> candidate concepts -> normalize/dedupe -> relationships ->
 * prerequisites -> validate -> persist (spec §7, §16).
 *
 * Safe to rerun: this always does a full course-level rebuild (delete then
 * recreate in one transaction) rather than incremental merging, so running
 * it twice never duplicates data (spec §17).
 */
export async function buildKnowledgeGraph(
  courseId: string,
  options?: { userId?: string | null },
): Promise<KnowledgeBuildSummary> {
  const summary: KnowledgeBuildSummary = {
    conceptsCreated: 0,
    conceptsMerged: 0,
    relationshipsCreated: 0,
    prerequisitesCreated: 0,
    lowConfidenceRelationships: 0,
    errors: [],
  };

  const course = await prisma.course.findUniqueOrThrow({ where: { id: courseId } });

  await prisma.course.update({
    where: { id: courseId },
    data: { knowledgeStatus: "PROCESSING", knowledgeError: null },
  });

  try {
    const chunks = await loadReadyChunks(courseId);
    if (chunks.length === 0) {
      throw new Error("This course has no processed documents to build a knowledge graph from.");
    }

    const candidateConcepts = await extractConceptsFromChunks(course.title, chunks, options);
    if (candidateConcepts.length === 0) {
      throw new Error("No concepts could be extracted from this course's material.");
    }

    const deterministicMerge = mergeByNormalizedName(candidateConcepts);
    summary.conceptsMerged += deterministicMerge.mergedCount;

    const semanticMerge = await mergeSemanticDuplicates(
      course.title,
      deterministicMerge.concepts,
      CONCEPT_MERGE_CONFIDENCE_THRESHOLD,
      options,
    );
    summary.conceptsMerged += semanticMerge.mergedCount;

    const finalConcepts = semanticMerge.concepts;
    const conceptSummaries = toConceptSummaries(finalConcepts);

    const relationshipCandidates = await extractRelationships(course.title, conceptSummaries, options);
    const knownNames = new Set(finalConcepts.map((concept) => concept.name));

    const relationshipValidation = validateEdges(
      relationshipCandidates.map((rel) => ({
        sourceName: rel.sourceConceptName,
        targetName: rel.targetConceptName,
        edgeType: rel.relationshipType,
        confidence: rel.confidence,
        evidence: rel.evidence,
      })),
      knownNames,
      RELATIONSHIP_CONFIDENCE,
    );

    const prerequisiteCandidates = await extractPrerequisites(course.title, conceptSummaries, options);
    const prerequisiteValidation = validateEdges(
      prerequisiteCandidates.map((prereq) => ({
        sourceName: prereq.prerequisiteConceptName,
        targetName: prereq.dependentConceptName,
        edgeType: "prerequisite",
        confidence: prereq.confidence,
        evidence: prereq.evidence,
      })),
      knownNames,
      RELATIONSHIP_CONFIDENCE,
    );

    const { accepted: acyclicPrerequisites, rejectedCycles } = filterAcyclicPrerequisites(
      prerequisiteValidation.accepted.map((edge) => ({
        prerequisiteName: edge.sourceName,
        dependentName: edge.targetName,
        confidence: edge.confidence,
        evidence: edge.evidence,
        needsReview: edge.needsReview,
      })),
    );

    if (rejectedCycles.length > 0) {
      summary.errors.push(
        `${rejectedCycles.length} prerequisite relationship(s) were rejected because they would create a cycle.`,
      );
    }

    const persistResult = await persistKnowledgeGraph(
      courseId,
      finalConcepts,
      relationshipValidation.accepted,
      acyclicPrerequisites,
    );

    summary.conceptsCreated = persistResult.conceptsCreated;
    summary.relationshipsCreated = persistResult.relationshipsCreated;
    summary.prerequisitesCreated = persistResult.prerequisitesCreated;
    summary.lowConfidenceRelationships = persistResult.lowConfidenceCount;

    await prisma.course.update({
      where: { id: courseId },
      data: { knowledgeStatus: "READY", knowledgeBuiltAt: new Date(), knowledgeError: null },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Knowledge graph build failed.";
    console.error(`Knowledge graph build failed for course ${courseId}:`, error);
    await prisma.course.update({
      where: { id: courseId },
      data: { knowledgeStatus: "FAILED", knowledgeError: message },
    });
    summary.errors.push(message);
  }

  return summary;
}
