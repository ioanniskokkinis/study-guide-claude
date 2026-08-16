import { prisma } from "@/lib/db/prisma";

/**
 * Basic Knowledge Hub search (Phase 15 §15) — filename/folder/course only,
 * plain case-insensitive `contains` queries against Postgres, same pattern
 * `searchConcepts` (src/lib/services/knowledge.ts) already uses. No
 * semantic/embedding search: `DocumentChunk.embedding` is declared in the
 * schema but nothing in this codebase ever populates it (no embedding
 * pipeline exists), so building "semantic search" here would mean adding a
 * whole new embedding-generation system this phase explicitly says not to
 * build ("this phase does not require a full global semantic search
 * system").
 */
export interface DocumentSearchResult {
  id: string;
  originalFilename: string;
  processingStatus: string;
  folderId: string | null;
  folderName: string | null;
  courseId: string;
  courseTitle: string;
}

/** Returns null if the course doesn't exist or isn't owned by `userId`. Empty/whitespace query returns every document in the course. */
export async function searchDocuments(
  userId: string,
  courseId: string,
  query: string,
): Promise<DocumentSearchResult[] | null> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId } });
  if (!course) return null;

  const trimmed = query.trim();

  const documents = await prisma.document.findMany({
    where: {
      courseId,
      ...(trimmed
        ? { originalFilename: { contains: trimmed, mode: "insensitive" as const } }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      originalFilename: true,
      processingStatus: true,
      folderId: true,
      folder: { select: { name: true } },
      course: { select: { id: true, title: true } },
    },
  });

  return documents.map((d) => ({
    id: d.id,
    originalFilename: d.originalFilename,
    processingStatus: d.processingStatus,
    folderId: d.folderId,
    folderName: d.folder?.name ?? null,
    courseId: d.course.id,
    courseTitle: d.course.title,
  }));
}
