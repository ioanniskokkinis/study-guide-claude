import { prisma } from "@/lib/db/prisma";
import type { RelationshipType } from "@/generated/prisma/enums";
import { buildKnowledgeGraph, type KnowledgeBuildSummary } from "@/lib/knowledge/knowledge-builder";

const VALID_RELATIONSHIP_TYPES: readonly RelationshipType[] = [
  "prerequisite",
  "contains",
  "related",
  "example_of",
  "contrasts_with",
  "causes",
  "part_of",
  "applies_to",
];

function isRelationshipType(value: string): value is RelationshipType {
  return (VALID_RELATIONSHIP_TYPES as readonly string[]).includes(value);
}

export class KnowledgeBuildInProgressError extends Error {
  constructor() {
    super("A knowledge graph build is already in progress for this course.");
  }
}

/** Returns null if the course doesn't exist or isn't owned by `userId`. */
export async function getKnowledgeSummary(userId: string, courseId: string) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, userId },
    select: {
      id: true,
      title: true,
      knowledgeStatus: true,
      knowledgeError: true,
      knowledgeBuiltAt: true,
      _count: { select: { concepts: true } },
    },
  });
  if (!course) {
    return null;
  }

  const [relationshipsCreated, prerequisitesCreated] = await Promise.all([
    prisma.conceptRelationship.count({
      where: { relationshipType: { not: "prerequisite" }, sourceConcept: { courseId } },
    }),
    prisma.conceptRelationship.count({
      where: { relationshipType: "prerequisite", sourceConcept: { courseId } },
    }),
  ]);

  return {
    courseId: course.id,
    courseTitle: course.title,
    knowledgeStatus: course.knowledgeStatus,
    knowledgeError: course.knowledgeError,
    knowledgeBuiltAt: course.knowledgeBuiltAt,
    conceptCount: course._count.concepts,
    relationshipCount: relationshipsCreated,
    prerequisiteCount: prerequisitesCreated,
  };
}

/** Throws KnowledgeBuildInProgressError if a build is already running. Returns null if not found/owned. */
export async function triggerKnowledgeBuild(
  userId: string,
  courseId: string,
): Promise<KnowledgeBuildSummary | null> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId } });
  if (!course) {
    return null;
  }
  if (course.knowledgeStatus === "PROCESSING") {
    throw new KnowledgeBuildInProgressError();
  }

  return buildKnowledgeGraph(courseId, { userId });
}

export interface ConceptSearchResult {
  concepts: Array<{
    id: string;
    name: string;
    description: string | null;
    difficulty: number;
    sourceCount: number;
    relationshipCount: number;
  }>;
  total: number;
  page: number;
  pageSize: number;
}

/** Returns null if the course doesn't exist or isn't owned by `userId`. Search is server-side. */
export async function searchConcepts(
  userId: string,
  courseId: string,
  options: { query?: string; page?: number; pageSize?: number } = {},
): Promise<ConceptSearchResult | null> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId } });
  if (!course) {
    return null;
  }

  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
  const query = options.query?.trim();

  const where = {
    courseId,
    ...(query
      ? {
          OR: [
            { name: { contains: query, mode: "insensitive" as const } },
            { description: { contains: query, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [concepts, total] = await Promise.all([
    prisma.concept.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        description: true,
        difficulty: true,
        _count: { select: { sources: true, relationshipsAsSource: true, relationshipsAsTarget: true } },
      },
    }),
    prisma.concept.count({ where }),
  ]);

  return {
    concepts: concepts.map((concept) => ({
      id: concept.id,
      name: concept.name,
      description: concept.description,
      difficulty: concept.difficulty,
      sourceCount: concept._count.sources,
      relationshipCount: concept._count.relationshipsAsSource + concept._count.relationshipsAsTarget,
    })),
    total,
    page,
    pageSize,
  };
}

/**
 * Full detail for a concept: its own fields, source traceability, and its
 * relationships split into prerequisites / dependents ("used by") /
 * everything else, per the direction convention documented in
 * schema.prisma (prerequisite edge: source is required to understand
 * target). Returns null if not found or not owned via the concept's course.
 */
export async function getConceptDetail(userId: string, conceptId: string) {
  const concept = await prisma.concept.findFirst({
    where: { id: conceptId, course: { userId } },
    include: {
      course: { select: { id: true, title: true } },
      sources: {
        include: {
          documentChunk: {
            select: {
              id: true,
              chunkIndex: true,
              document: { select: { id: true, originalFilename: true } },
            },
          },
        },
      },
      relationshipsAsSource: {
        include: { targetConcept: { select: { id: true, name: true } } },
      },
      relationshipsAsTarget: {
        include: { sourceConcept: { select: { id: true, name: true } } },
      },
    },
  });

  if (!concept) {
    return null;
  }

  const prerequisites = concept.relationshipsAsTarget
    .filter((rel) => rel.relationshipType === "prerequisite")
    .map((rel) => ({
      concept: rel.sourceConcept,
      confidence: rel.confidence,
      evidence: rel.evidence,
      needsReview: rel.needsReview,
    }));

  const usedBy = concept.relationshipsAsSource
    .filter((rel) => rel.relationshipType === "prerequisite")
    .map((rel) => ({
      concept: rel.targetConcept,
      confidence: rel.confidence,
      evidence: rel.evidence,
      needsReview: rel.needsReview,
    }));

  const related = [
    ...concept.relationshipsAsSource
      .filter((rel) => rel.relationshipType !== "prerequisite")
      .map((rel) => ({
        concept: rel.targetConcept,
        relationshipType: rel.relationshipType,
        direction: "outgoing" as const,
        confidence: rel.confidence,
        evidence: rel.evidence,
        needsReview: rel.needsReview,
      })),
    ...concept.relationshipsAsTarget
      .filter((rel) => rel.relationshipType !== "prerequisite")
      .map((rel) => ({
        concept: rel.sourceConcept,
        relationshipType: rel.relationshipType,
        direction: "incoming" as const,
        confidence: rel.confidence,
        evidence: rel.evidence,
        needsReview: rel.needsReview,
      })),
  ];

  return {
    id: concept.id,
    name: concept.name,
    description: concept.description,
    difficulty: concept.difficulty,
    course: concept.course,
    sources: concept.sources.map((source) => ({
      id: source.id,
      evidence: source.evidence,
      relevance: source.relevance,
      documentId: source.documentChunk.document.id,
      documentName: source.documentChunk.document.originalFilename,
      chunkIndex: source.documentChunk.chunkIndex,
    })),
    prerequisites,
    usedBy,
    related,
  };
}

export interface GraphData {
  nodes: Array<{ id: string; name: string; difficulty: number }>;
  edges: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    relationshipType: string;
    confidence: number;
    evidence: string;
    needsReview: boolean;
  }>;
}

/** Returns null if the course doesn't exist or isn't owned by `userId`. */
export async function getGraphData(
  userId: string,
  courseId: string,
  relationshipTypes?: string[],
): Promise<GraphData | null> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId } });
  if (!course) {
    return null;
  }

  const [concepts, relationships] = await Promise.all([
    prisma.concept.findMany({
      where: { courseId },
      select: { id: true, name: true, difficulty: true },
    }),
    prisma.conceptRelationship.findMany({
      where: {
        sourceConcept: { courseId },
        ...(relationshipTypes && relationshipTypes.length > 0
          ? { relationshipType: { in: relationshipTypes.filter(isRelationshipType) } }
          : {}),
      },
      select: {
        id: true,
        sourceConceptId: true,
        targetConceptId: true,
        relationshipType: true,
        confidence: true,
        evidence: true,
        needsReview: true,
      },
    }),
  ]);

  return {
    nodes: concepts,
    edges: relationships.map((rel) => ({
      id: rel.id,
      sourceId: rel.sourceConceptId,
      targetId: rel.targetConceptId,
      relationshipType: rel.relationshipType,
      confidence: rel.confidence,
      evidence: rel.evidence,
      needsReview: rel.needsReview,
    })),
  };
}
