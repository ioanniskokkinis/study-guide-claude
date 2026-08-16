import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { hashDocumentContent, uploadDocumentDeduped } from "@/lib/services/documents";
import { makeTextPdfBuffer } from "./fixtures";

/** Phase 15 §13-14 — content-hash duplicate detection, no reprocessing. */
describe("uploadDocumentDeduped", () => {
  let userId: string;
  let courseId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `dedup-${suffix}@example.com` } })).id;
    courseId = (await prisma.course.create({ data: { userId, title: `Dedup Course ${suffix}` } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("computes a stable SHA-256 hash for identical content", () => {
    const bufferA = Buffer.from("identical content");
    const bufferB = Buffer.from("identical content");
    const bufferC = Buffer.from("different content");
    expect(hashDocumentContent(bufferA)).toBe(hashDocumentContent(bufferB));
    expect(hashDocumentContent(bufferA)).not.toBe(hashDocumentContent(bufferC));
  });

  it("the first upload of new content is created, the second identical upload is detected as a duplicate", async () => {
    const buffer = await makeTextPdfBuffer("Unique dedup test content one.");

    const first = await uploadDocumentDeduped(courseId, "first.pdf", "application/pdf", buffer);
    expect(first.status).toBe("created");

    const documentsBefore = await prisma.document.count({ where: { courseId } });
    const second = await uploadDocumentDeduped(courseId, "second-copy.pdf", "application/pdf", buffer);
    const documentsAfter = await prisma.document.count({ where: { courseId } });

    expect(second.status).toBe("duplicate");
    expect(second.document.id).toBe(first.document.id);
    expect(documentsAfter).toBe(documentsBefore);
  });

  it("does not re-run ingestion (chunking) for a duplicate upload", async () => {
    const buffer = await makeTextPdfBuffer("Unique dedup test content two, for chunk-count checking.");
    const first = await uploadDocumentDeduped(courseId, "chunked.pdf", "application/pdf", buffer);
    const chunkCountBefore = await prisma.documentChunk.count({ where: { documentId: first.document.id } });

    await uploadDocumentDeduped(courseId, "chunked-again.pdf", "application/pdf", buffer);
    const chunkCountAfter = await prisma.documentChunk.count({ where: { documentId: first.document.id } });

    expect(chunkCountAfter).toBe(chunkCountBefore);
  });

  it("the same content uploaded to a different course is not considered a duplicate (scoped per course)", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const otherCourseId = (await prisma.course.create({ data: { userId, title: `Other course ${suffix}` } })).id;
    const buffer = await makeTextPdfBuffer("Cross-course dedup scoping content.");

    const first = await uploadDocumentDeduped(courseId, "scope-a.pdf", "application/pdf", buffer);
    const second = await uploadDocumentDeduped(otherCourseId, "scope-b.pdf", "application/pdf", buffer);

    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    expect(second.document.id).not.toBe(first.document.id);
  });

  it("an invalid (non-PDF) upload is rejected before any dedup check runs", async () => {
    const buffer = Buffer.from("not a pdf");
    await expect(uploadDocumentDeduped(courseId, "notes.txt", "text/plain", buffer)).rejects.toThrow();
  });
});
