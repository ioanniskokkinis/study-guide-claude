import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage/local-storage";
import { processDocument } from "@/lib/documents/document-processor";
import { validatePdfUpload, sanitizeOriginalFilename } from "@/lib/documents/validation";

function buildStorageKey(courseId: string): string {
  // Server-generated key — never derived from the client-supplied filename.
  return `${courseId}/${randomUUID()}.pdf`;
}

/**
 * Validates, stores, and processes an uploaded PDF. Callers must verify the
 * course belongs to the current user before calling this — it does not
 * re-check ownership itself.
 */
export async function uploadDocument(
  courseId: string,
  originalName: string,
  declaredMimeType: string,
  buffer: Buffer,
) {
  validatePdfUpload(originalName, declaredMimeType, buffer);

  const storageKey = buildStorageKey(courseId);
  await storage.save(storageKey, buffer);

  const document = await prisma.document.create({
    data: {
      courseId,
      filename: storageKey.split("/").pop() as string,
      originalFilename: sanitizeOriginalFilename(originalName),
      mimeType: "application/pdf",
      fileSize: buffer.length,
      type: "pdf",
      storagePath: storageKey,
      processingStatus: "UPLOADED",
    },
  });

  await processDocument(document.id);

  // Internal storage details never leave the server (spec §10, §13).
  return prisma.document.findUniqueOrThrow({
    where: { id: document.id },
    omit: { storagePath: true, filename: true },
  });
}

/** Returns null (rather than throwing) when the document doesn't exist or isn't owned by `userId`. */
export function getDocumentForUser(userId: string, documentId: string) {
  return prisma.document.findFirst({
    where: { id: documentId, course: { userId } },
    // Internal storage details never leave the server (spec §10, §13).
    omit: { storagePath: true, filename: true },
    include: {
      _count: { select: { chunks: true } },
      course: { select: { id: true, title: true } },
    },
  });
}

export function getDocumentChunks(documentId: string) {
  return prisma.documentChunk.findMany({
    where: { documentId },
    orderBy: { chunkIndex: "asc" },
  });
}

/** Returns false if the document doesn't exist or isn't owned by `userId`. */
export async function deleteDocumentForUser(userId: string, documentId: string): Promise<boolean> {
  const document = await prisma.document.findFirst({
    where: { id: documentId, course: { userId } },
  });

  if (!document) {
    return false;
  }

  await prisma.document.delete({ where: { id: documentId } });
  await storage.delete(document.storagePath).catch((error) => {
    console.error(`Failed to delete stored file ${document.storagePath}:`, error);
  });

  return true;
}
