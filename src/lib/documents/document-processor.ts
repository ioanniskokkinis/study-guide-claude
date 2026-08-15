import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage/local-storage";
import { env } from "@/lib/env";
import { extractPdfText, NoExtractableTextError } from "./pdf-extractor";
import { chunkText } from "./chunker";

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
    const { text, pageCount } = await extractPdfText(fileBuffer);

    const chunks = chunkText(text, {
      chunkSize: env.DOCUMENT_CHUNK_SIZE,
      chunkOverlap: env.DOCUMENT_CHUNK_OVERLAP,
      source: document.originalFilename,
    });

    await prisma.$transaction(async (tx) => {
      await tx.documentChunk.deleteMany({ where: { documentId } });

      if (chunks.length > 0) {
        await tx.documentChunk.createMany({
          data: chunks.map((chunk) => ({
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
