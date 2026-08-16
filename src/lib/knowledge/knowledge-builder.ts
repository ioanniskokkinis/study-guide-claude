import { prisma } from "@/lib/db/prisma";
import type { ConceptSummaryInput } from "@/lib/ai/prompts/relationship-extraction";
import { extractConceptsFromChunks } from "./concept-extractor";
import { mergeByNormalizedName, mergeSemanticDuplicates, type MergedConcept } from "./concept-normalizer";
import { extractRelationships } from "./relationship-extractor";
import { extractPrerequisites } from "./prerequisite-analyzer";
import { validateEdges, filterAcyclicPrerequisites, type ValidatedEdge } from "./graph-validator";
import { persistConcepts, persistRelationships, type AcyclicPrerequisiteEdge } from "./persist";
import { CONCEPT_MERGE_CONFIDENCE_THRESHOLD, EVIDENCE_SNIPPETS_PER_CONCEPT, RELATIONSHIP_CONFIDENCE } from "./config";

export interface KnowledgeBuildSummary {
  conceptsCreated: number;
  conceptsMerged: number;
  relationshipsCreated: number;
  prerequisitesCreated: number;
  lowConfidenceRelationships: number;
  errors: string[];
}

/**
 * Real, machine-readable stages for the progress UI (production-hardening
 * phase §A2) — never a fake timer. Each stage's percentage band reflects
 * roughly how much of a typical build's wall-clock time it takes; concept
 * extraction (many small batched AI calls) is the largest band and is
 * itself scaled by real batch counts via `updateStage`'s caller.
 */
export type KnowledgeBuildStage =
  | "loading"
  | "extracting-concepts"
  | "normalizing-concepts"
  | "semantic-merge"
  | "relationships"
  | "prerequisites"
  | "validation"
  | "saving"
  | "complete"
  | "failed";

async function updateStage(courseId: string, stage: KnowledgeBuildStage, message: string, progress: number): Promise<void> {
  await prisma.course.update({
    where: { id: courseId },
    data: { knowledgeStage: stage, knowledgeStageMessage: message, knowledgeProgress: Math.max(0, Math.min(100, Math.round(progress))) },
  });
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
 * Relationships and prerequisites (spec §7, §16), attempted only after
 * concepts are already safely persisted. Anything unexpected here (a bug, a
 * DB error — normal AI-call failures are already absorbed batch-by-batch
 * inside extractRelationships/extractPrerequisites, which skip a bad batch
 * rather than throw) degrades to "concepts only, no relationships" instead
 * of losing the concepts that already succeeded (production-hardening
 * phase §A7's partial recovery).
 */
async function buildAndPersistGraph(
  courseId: string,
  courseTitle: string,
  finalConcepts: MergedConcept[],
  nameToId: Map<string, string>,
  options: { userId?: string | null } | undefined,
  summary: KnowledgeBuildSummary,
): Promise<void> {
  let relationshipEdges: ValidatedEdge[] = [];
  let acyclicPrerequisites: AcyclicPrerequisiteEdge[] = [];

  try {
    const conceptSummaries = toConceptSummaries(finalConcepts);
    const knownNames = new Set(finalConcepts.map((concept) => concept.name));

    await updateStage(courseId, "relationships", "Finding relationships…", 55);
    const relationshipCandidates = await extractRelationships(courseTitle, conceptSummaries, options);
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

    await updateStage(courseId, "prerequisites", "Analyzing prerequisites…", 75);
    const prerequisiteCandidates = await extractPrerequisites(courseTitle, conceptSummaries, options);
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

    await updateStage(courseId, "validation", "Validating graph…", 90);
    const { accepted, rejectedCycles } = filterAcyclicPrerequisites(
      prerequisiteValidation.accepted.map((edge) => ({
        prerequisiteName: edge.sourceName,
        dependentName: edge.targetName,
        confidence: edge.confidence,
        evidence: edge.evidence,
        needsReview: edge.needsReview,
      })),
    );

    relationshipEdges = relationshipValidation.accepted;
    acyclicPrerequisites = accepted;
    if (rejectedCycles.length > 0) {
      summary.errors.push(`${rejectedCycles.length} prerequisite relationship(s) were rejected because they would create a cycle.`);
    }
  } catch (error) {
    console.error(`Relationship/prerequisite analysis failed for course ${courseId}, keeping concepts only:`, error);
    summary.errors.push("Relationships and prerequisites could not be fully analyzed this time; your concepts were still saved.");
  }

  await updateStage(courseId, "saving", "Saving relationships…", 95);
  const persistResult = await persistRelationships(nameToId, relationshipEdges, acyclicPrerequisites);
  summary.relationshipsCreated = persistResult.relationshipsCreated;
  summary.prerequisitesCreated = persistResult.prerequisitesCreated;
  summary.lowConfidenceRelationships = persistResult.lowConfidenceCount;
}

/**
 * Rebuilds a course's knowledge graph from its processed documents:
 * chunks -> candidate concepts -> normalize/dedupe -> relationships ->
 * prerequisites -> validate -> persist (spec §7, §16).
 *
 * Safe to rerun: concepts are always deleted-then-recreated for the course
 * (never incrementally merged), so running it twice never duplicates data
 * (spec §17). Concepts are persisted as soon as they're ready — before
 * relationships/prerequisites are even attempted — so a later-stage
 * failure never discards already-successful extraction work
 * (production-hardening phase §A7). Progress is written to the DB after
 * every real stage so a caller (or another request) can poll it; this
 * function itself is meant to be invoked without being awaited by an HTTP
 * handler (see triggerKnowledgeBuild) so a slow build never holds a
 * request open (§A1).
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
    data: {
      knowledgeStatus: "PROCESSING",
      knowledgeError: null,
      knowledgeStartedAt: new Date(),
      knowledgeProgress: 0,
      knowledgeStage: "loading",
      knowledgeStageMessage: "Loading documents…",
    },
  });

  try {
    const chunks = await loadReadyChunks(courseId);
    if (chunks.length === 0) {
      throw new Error("This course has no processed documents to build a knowledge graph from.");
    }

    await updateStage(courseId, "extracting-concepts", "Extracting concepts…", 5);
    const candidateConcepts = await extractConceptsFromChunks(course.title, chunks, {
      userId: options?.userId,
      onProgress: (processed, total) => {
        const progress = 5 + Math.round((processed / total) * 35); // 5..40
        void updateStage(courseId, "extracting-concepts", `Extracting concepts — batch ${processed}/${total}`, progress).catch(() => {});
      },
    });
    if (candidateConcepts.length === 0) {
      throw new Error("No concepts could be extracted from this course's material.");
    }

    await updateStage(courseId, "normalizing-concepts", "Normalizing & deduplicating…", 40);
    const deterministicMerge = mergeByNormalizedName(candidateConcepts);
    summary.conceptsMerged += deterministicMerge.mergedCount;

    await updateStage(courseId, "semantic-merge", "Finding near-duplicate concepts…", 45);
    const semanticMerge = await mergeSemanticDuplicates(
      course.title,
      deterministicMerge.concepts,
      CONCEPT_MERGE_CONFIDENCE_THRESHOLD,
      options,
    );
    summary.conceptsMerged += semanticMerge.mergedCount;
    if (semanticMerge.skippedReason) {
      summary.errors.push(semanticMerge.skippedReason);
    }

    const finalConcepts = semanticMerge.concepts;

    // Persisted now, before relationships/prerequisites are even attempted (§A7).
    await updateStage(courseId, "saving", "Saving concepts…", 50);
    const { nameToId } = await persistConcepts(courseId, finalConcepts);
    summary.conceptsCreated = finalConcepts.length;

    await buildAndPersistGraph(courseId, course.title, finalConcepts, nameToId, options, summary);

    await prisma.course.update({
      where: { id: courseId },
      data: {
        knowledgeStatus: "READY",
        knowledgeBuiltAt: new Date(),
        knowledgeError: summary.errors.length > 0 ? summary.errors.join(" ") : null,
        knowledgeStage: "complete",
        knowledgeStageMessage: "Knowledge base ready.",
        knowledgeProgress: 100,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Knowledge graph build failed.";
    console.error(`Knowledge graph build failed for course ${courseId}:`, error);
    await prisma.course.update({
      where: { id: courseId },
      data: { knowledgeStatus: "FAILED", knowledgeError: message, knowledgeStage: "failed", knowledgeStageMessage: message },
    });
    summary.errors.push(message);
  }

  return summary;
}
