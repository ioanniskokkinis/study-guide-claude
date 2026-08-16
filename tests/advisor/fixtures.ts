import { prisma } from "@/lib/db/prisma";

/**
 * Seeds a course with a folder, a READY document inside it, one chunk, and
 * N concepts each sourced from that chunk — the minimum shape scope
 * resolution / knowledge-gap analysis needs to find real concepts, mirroring
 * what the real ingestion + knowledge-graph pipeline (Phases 2-3) produces.
 */
export async function seedCourseWithConcepts(
  userId: string,
  opts: { courseTitle?: string; conceptCount?: number; withFolder?: boolean } = {},
) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const course = await prisma.course.create({ data: { userId, title: opts.courseTitle ?? `Advisor Course ${suffix}` } });

  const folder = opts.withFolder
    ? await prisma.folder.create({ data: { courseId: course.id, name: `Folder ${suffix}` } })
    : null;

  const document = await prisma.document.create({
    data: {
      courseId: course.id,
      folderId: folder?.id ?? null,
      filename: `f-${suffix}.pdf`,
      originalFilename: `Notes ${suffix}.pdf`,
      mimeType: "application/pdf",
      fileSize: 100,
      type: "pdf",
      storagePath: `advisor-fixture/${suffix}.pdf`,
      processingStatus: "READY",
    },
  });

  const chunk = await prisma.documentChunk.create({
    data: { documentId: document.id, text: "Fixture chunk text.", chunkIndex: 0, tokenCount: 10 },
  });

  const concepts = [];
  for (let i = 0; i < (opts.conceptCount ?? 3); i++) {
    const concept = await prisma.concept.create({
      data: { courseId: course.id, name: `Concept ${i} ${suffix}`, normalizedName: `concept-${i}-${suffix}` },
    });
    await prisma.conceptSource.create({
      data: { conceptId: concept.id, documentChunkId: chunk.id, evidence: "Fixture evidence.", relevance: 1 },
    });
    concepts.push(concept);
  }

  return { course, folder, document, chunk, concepts };
}
