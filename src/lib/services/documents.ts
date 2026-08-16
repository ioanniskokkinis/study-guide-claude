import { randomUUID, createHash } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage/local-storage";
import { processDocument } from "@/lib/documents/document-processor";
import { validatePdfUpload, sanitizeOriginalFilename } from "@/lib/documents/validation";

function buildStorageKey(courseId: string): string {
  // Server-generated key — never derived from the client-supplied filename.
  return `${courseId}/${randomUUID()}.pdf`;
}

/** SHA-256 of the raw uploaded bytes (Phase 15 §13) — the duplicate-detection key, scoped per course. */
export function hashDocumentContent(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Validates, stores, and processes an uploaded PDF. Callers must verify the
 * course belongs to the current user before calling this — it does not
 * re-check ownership itself. Does not check for duplicates itself — see
 * `uploadDocumentDeduped` (Phase 15 §13-14), which wraps this for the bulk
 * upload path; kept separate so this function's existing contract (used by
 * the original single-file upload route and its tests since Phase 2) never
 * changes shape.
 */
export async function uploadDocument(
  courseId: string,
  originalName: string,
  declaredMimeType: string,
  buffer: Buffer,
  folderId?: string | null,
) {
  validatePdfUpload(originalName, declaredMimeType, buffer);

  const storageKey = buildStorageKey(courseId);
  await storage.save(storageKey, buffer);

  const document = await prisma.document.create({
    data: {
      courseId,
      folderId: folderId ?? null,
      filename: storageKey.split("/").pop() as string,
      originalFilename: sanitizeOriginalFilename(originalName),
      mimeType: "application/pdf",
      fileSize: buffer.length,
      type: "pdf",
      storagePath: storageKey,
      processingStatus: "UPLOADED",
      contentHash: hashDocumentContent(buffer),
    },
  });

  await processDocument(document.id);

  return prisma.document.findUniqueOrThrow({ where: { id: document.id }, ...PUBLIC_DOCUMENT_QUERY });
}

const PUBLIC_DOCUMENT_QUERY = {
  // Internal storage details never leave the server (spec §10, §13).
  omit: { storagePath: true, filename: true },
  include: {
    _count: { select: { chunks: true } },
    course: { select: { id: true, title: true } },
  },
} as const;

export type PublicDocument = NonNullable<Awaited<ReturnType<typeof getDocumentForUser>>>;

export type UploadDedupResult =
  | { status: "duplicate"; document: PublicDocument }
  | { status: "created"; document: PublicDocument };

/**
 * Same validation/storage/ingestion as `uploadDocument`, but first checks
 * whether a document with identical content already exists in this course
 * (Phase 15 §13-14) — if so, returns it instead of storing and re-processing
 * a byte-for-byte duplicate (spec §14: bulk uploads must not cause
 * uncontrolled AI/embedding/storage cost from re-ingesting the same file).
 * Callers must verify course ownership first, same as `uploadDocument`.
 */
export async function uploadDocumentDeduped(
  courseId: string,
  originalName: string,
  declaredMimeType: string,
  buffer: Buffer,
  folderId?: string | null,
): Promise<UploadDedupResult> {
  // Validate before hashing/querying so a malformed upload never even reaches the dedup check.
  validatePdfUpload(originalName, declaredMimeType, buffer);

  const contentHash = hashDocumentContent(buffer);
  const existing = await prisma.document.findFirst({
    where: { courseId, contentHash },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  if (existing) {
    const document = await prisma.document.findFirstOrThrow({ where: { id: existing.id }, ...PUBLIC_DOCUMENT_QUERY });
    return { status: "duplicate", document };
  }

  const document = await uploadDocument(courseId, originalName, declaredMimeType, buffer, folderId);
  return { status: "created", document };
}

/** Returns null (rather than throwing) when the document doesn't exist or isn't owned by `userId`. */
export function getDocumentForUser(userId: string, documentId: string) {
  return prisma.document.findFirst({ where: { id: documentId, course: { userId } }, ...PUBLIC_DOCUMENT_QUERY });
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

/**
 * Re-runs ingestion for a document that previously failed (Phase 15 §8) —
 * reuses `processDocument` exactly as the original upload does, never a
 * second pipeline. Returns null if the document doesn't exist or isn't
 * owned by `userId`.
 */
export async function retryDocumentIngestion(userId: string, documentId: string) {
  const document = await prisma.document.findFirst({ where: { id: documentId, course: { userId } } });
  if (!document) return null;

  await processDocument(documentId);

  return prisma.document.findUniqueOrThrow({ where: { id: documentId }, ...PUBLIC_DOCUMENT_QUERY });
}

/** Returns false if the document doesn't exist or isn't owned by `userId`. */
export async function renameDocument(userId: string, documentId: string, newName: string): Promise<boolean> {
  const result = await prisma.document.updateMany({
    where: { id: documentId, course: { userId } },
    data: { originalFilename: sanitizeOriginalFilename(newName) },
  });
  return result.count > 0;
}
