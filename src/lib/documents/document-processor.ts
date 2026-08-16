import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage/local-storage";
import { env } from "@/lib/env";
import { extractPdfText, NoExtractableTextError } from "./pdf-extractor";
import { chunkText } from "./chunker";

/**
 * PostgreSQL text/varchar columns cannot contain the NUL character
 * (\u0000 / byte 0x00). Some PDF extraction libraries can preserve NUL
 * bytes from embedded fonts, binary objects, or malformed PDF text.
 *
 * Remove NUL bytes before anything is passed to Prisma/PostgreSQL.
 */
function sanitizeText(value: string): string {
  return value.replace(/\u0000/g, "");
}

/** Recursively sanitizes chunk metadata so a NUL byte can't sneak in through a nested string. */
function sanitizeMetadata<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeText(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadata(item)) as T;
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [sanitizeText(key), sanitizeMetadata(item)]),
    ) as T;
  }

  return value;
}

/**
 * Runs a document through extraction and chunking, updating its status as
 * it goes. Synchronous and request-scoped for now — no queue or worker —
 * but kept as a standalone function over a `documentId` so it can be moved
 * behind a background job later without changing its contract.
 */
export async function processDocument(documentId: string): Promise<void> {
  const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });

  try {
    await prisma.document.update({
      where: { id: documentId },
      data: { processingStatus: "PROCESSING", processingError: null },
    });

    const fileBuffer = await storage.read(document.storagePath);
    const { text: extractedText, pageCount } = await extractPdfText(fileBuffer);

    // PostgreSQL rejects NUL bytes (0x00) in text/varchar values. Sanitize
    // immediately after extraction so the cleaned text is used consistently
    // for chunking and for the document.extractedText column.
    const text = sanitizeText(extractedText);

    const chunks = chunkText(text, {
      chunkSize: env.DOCUMENT_CHUNK_SIZE,
      chunkOverlap: env.DOCUMENT_CHUNK_OVERLAP,
      source: sanitizeText(document.originalFilename),
    });

    const sanitizedChunks = chunks.map((chunk) => ({
      ...chunk,
      text: sanitizeText(chunk.text),
      metadata: sanitizeMetadata(chunk.metadata),
    }));

    await prisma.$transaction(async (tx) => {
      await tx.documentChunk.deleteMany({ where: { documentId } });

      if (sanitizedChunks.length > 0) {
        await tx.documentChunk.createMany({
          data: sanitizedChunks.map((chunk) => ({
            documentId,
            chunkIndex: chunk.index,
            text: chunk.text,
            tokenCount: chunk.tokenCount,
            metadata: chunk.metadata,
          })),
        });
      }

      await tx.document.update({
        where: { id: documentId },
        data: {
          extractedText: text,
          pageCount,
          processingStatus: "READY",
          processingError: null,
        },
      });
    });
  } catch (error) {
    const message =
      error instanceof NoExtractableTextError
        ? error.message
        : "The document could not be processed.";

    console.error(`Document processing failed for document ${documentId}:`, error);

    await prisma.document.update({
      where: { id: documentId },
      data: { processingStatus: "FAILED", processingError: message },
    });
  }
}
