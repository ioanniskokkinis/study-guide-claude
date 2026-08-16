import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/pdf-extractor", async () => {
  const actual = await vi.importActual<typeof import("@/lib/documents/pdf-extractor")>("@/lib/documents/pdf-extractor");
  return { ...actual, extractPdfText: vi.fn() };
});

import { extractPdfText } from "@/lib/documents/pdf-extractor";
import { prisma } from "@/lib/db/prisma";
import { createCourse, deleteCourse } from "@/lib/services/courses";
import { uploadDocument, getDocumentChunks } from "@/lib/services/documents";

/** The literal NUL character, built at runtime rather than embedded as a raw byte in this source file. */
const NUL = String.fromCharCode(0);

/**
 * Regression test for the NUL-byte ingestion bug: PDF text extraction can
 * preserve raw NUL bytes from embedded fonts/binary objects, and
 * PostgreSQL's UTF8 encoding rejects them outright ("invalid byte sequence
 * for encoding UTF8: 0x00"), which previously failed every document in a
 * multi-file upload batch. document-processor.ts must sanitize NUL bytes
 * out of the extracted text, the persisted document.extractedText column,
 * and every chunk's text/metadata before they ever reach Prisma.
 */
function pdfBuffer(): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n", "ascii"), Buffer.from("fixture body", "ascii")]);
}

describe("processDocument NUL-byte sanitization", () => {
  let userId: string;
  let courseId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `doc-processor-${suffix}@example.com` } });
    userId = user.id;
    const course = await createCourse(userId, { title: "NUL sanitization course" });
    courseId = course.id;
  });

  afterAll(async () => {
    await deleteCourse(userId, courseId);
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  afterEach(() => {
    vi.mocked(extractPdfText).mockReset();
  });

  it("processes successfully to READY when extracted text contains raw NUL bytes", async () => {
    vi.mocked(extractPdfText).mockResolvedValue({
      text: `Firewalls filter${NUL} network traffic.\n\nPorts identify${NUL}${NUL} services.`,
      pageCount: 1,
    });

    const document = await uploadDocument(courseId, "nul-bytes.pdf", "application/pdf", pdfBuffer());

    expect(document.processingStatus).toBe("READY");
    expect(document.processingError).toBeNull();
    expect(document.extractedText).not.toBeNull();
    expect(document.extractedText).not.toContain(NUL);
    expect(document.extractedText).toContain("Firewalls filter network traffic");
  });

  it("strips NUL bytes from every persisted chunk's text", async () => {
    vi.mocked(extractPdfText).mockResolvedValue({
      text: `Chunk one text${NUL} here.\n\nChunk two${NUL} text here.`,
      pageCount: 1,
    });

    const document = await uploadDocument(courseId, "nul-bytes-chunks.pdf", "application/pdf", pdfBuffer());
    const chunks = await getDocumentChunks(document.id);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.text).not.toContain(NUL);
    }
  });

  it("stores clean metadata for a normally-named document", async () => {
    vi.mocked(extractPdfText).mockResolvedValue({ text: "Some clean body text for chunking.", pageCount: 1 });

    const document = await uploadDocument(courseId, "clean-name.pdf", "application/pdf", pdfBuffer());
    const chunks = await getDocumentChunks(document.id);

    for (const chunk of chunks) {
      expect(JSON.stringify(chunk.metadata)).not.toContain(NUL);
    }
  });
});
