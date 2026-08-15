import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { persistKnowledgeGraph, type AcyclicPrerequisiteEdge } from "@/lib/knowledge/persist";
import type { MergedConcept } from "@/lib/knowledge/concept-normalizer";
import type { ValidatedEdge } from "@/lib/knowledge/graph-validator";

describe("persistKnowledgeGraph", () => {
  let userId: string;
  let courseId: string;
  let chunkId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-persist-${suffix}@example.com` } });
    userId = user.id;

    const course = await prisma.course.create({ data: { userId, title: "Networking" } });
    courseId = course.id;

    const document = await prisma.document.create({
      data: {
        courseId,
        filename: "f.pdf",
        originalFilename: "lecture.pdf",
        mimeType: "application/pdf",
        fileSize: 10,
        type: "pdf",
        storagePath: "x/y.pdf",
        processingStatus: "READY",
      },
    });

    const chunk = await prisma.documentChunk.create({
      data: {
        documentId: document.id,
        text: "TCP establishes connections. Ports identify services.",
        chunkIndex: 0,
        tokenCount: 8,
      },
    });
    chunkId = chunk.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  function buildInputs(): {
    concepts: MergedConcept[];
    relationships: ValidatedEdge[];
    prerequisites: AcyclicPrerequisiteEdge[];
  } {
    return {
      concepts: [
        {
          name: "TCP",
          normalizedName: "tcp",
          description: "A protocol.",
          difficulty: 2,
          evidence: [{ chunkId, text: "TCP establishes connections." }],
        },
        {
          name: "Ports",
          normalizedName: "ports",
          description: "Service identifiers.",
          difficulty: 2,
          evidence: [{ chunkId, text: "Ports identify services." }],
        },
      ],
      relationships: [
        {
          sourceName: "TCP",
          targetName: "Ports",
          edgeType: "related",
          confidence: 0.9,
          evidence: "TCP uses ports.",
          needsReview: false,
        },
      ],
      prerequisites: [
        {
          prerequisiteName: "TCP",
          dependentName: "Ports",
          confidence: 0.9,
          evidence: "Understanding TCP is needed before ports.",
          needsReview: false,
        },
      ],
    };
  }

  it("persists concepts, sources, relationships, and prerequisites", async () => {
    const { concepts, relationships, prerequisites } = buildInputs();
    const result = await persistKnowledgeGraph(courseId, concepts, relationships, prerequisites);

    expect(result.conceptsCreated).toBe(2);
    expect(result.relationshipsCreated).toBe(1);
    expect(result.prerequisitesCreated).toBe(1);

    const dbConcepts = await prisma.concept.findMany({ where: { courseId } });
    expect(dbConcepts).toHaveLength(2);

    const dbSources = await prisma.conceptSource.findMany({ where: { concept: { courseId } } });
    expect(dbSources).toHaveLength(2);

    const dbRelationships = await prisma.conceptRelationship.findMany({
      where: { sourceConcept: { courseId } },
    });
    expect(dbRelationships).toHaveLength(2); // 1 "related" + 1 "prerequisite"
  });

  it("running it twice with the same input does not duplicate data (idempotent rebuild)", async () => {
    const { concepts, relationships, prerequisites } = buildInputs();

    await persistKnowledgeGraph(courseId, concepts, relationships, prerequisites);
    const firstConceptCount = await prisma.concept.count({ where: { courseId } });
    const firstRelationshipCount = await prisma.conceptRelationship.count({
      where: { sourceConcept: { courseId } },
    });

    await persistKnowledgeGraph(courseId, concepts, relationships, prerequisites);
    const secondConceptCount = await prisma.concept.count({ where: { courseId } });
    const secondRelationshipCount = await prisma.conceptRelationship.count({
      where: { sourceConcept: { courseId } },
    });

    expect(secondConceptCount).toBe(firstConceptCount);
    expect(secondRelationshipCount).toBe(firstRelationshipCount);
    expect(secondConceptCount).toBe(2);
  });
});
