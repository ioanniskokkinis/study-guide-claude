import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { prisma } from "@/lib/db/prisma";
import { createCourse, deleteCourse } from "@/lib/services/courses";
import {
  deleteDocumentForUser,
  getDocumentChunks,
  getDocumentForUser,
  uploadDocument,
} from "@/lib/services/documents";
import { UploadValidationError } from "@/lib/documents/validation";

async function makeTextPdfBuffer(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage();
  page.setFont(font);
  page.drawText(text, { x: 50, y: 700, size: 12, lineHeight: 16 });
  return Buffer.from(await doc.save());
}

async function makeBlankPdfBuffer(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage();
  return Buffer.from(await doc.save());
}

describe("documents service", () => {
  let user: { id: string };
  let otherUser: { id: string };
  let courseId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    user = await prisma.user.create({ data: { email: `test-doc-${suffix}@example.com` } });
    otherUser = await prisma.user.create({
      data: { email: `test-doc-other-${suffix}@example.com` },
    });
    const course = await createCourse(user.id, { title: "Ingestion test course" });
    courseId = course.id;
  });

  afterAll(async () => {
    // Delete through the service so uploaded files are removed from storage,
    // not just their database rows.
    await deleteCourse(user.id, courseId);
    await prisma.user.deleteMany({ where: { id: { in: [user.id, otherUser.id] } } });
  });

  it("processes a valid PDF into a READY document with chunks", async () => {
    const buffer = await makeTextPdfBuffer(
      "Firewalls filter network traffic.\nPorts identify which service traffic is destined for.\nTCP establishes a connection with a three-way handshake.",
    );

    const document = await uploadDocument(courseId, "lecture-01.pdf", "application/pdf", buffer);

    expect(document.processingStatus).toBe("READY");
    expect(document.processingError).toBeNull();
    expect(document.pageCount).toBe(1);
    expect(document.extractedText).toContain("Firewalls filter network traffic");

    const chunks = await getDocumentChunks(document.id);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
  });

  it("marks a document with no extractable text as FAILED with a useful error", async () => {
    const buffer = await makeBlankPdfBuffer();

    const document = await uploadDocument(courseId, "blank.pdf", "application/pdf", buffer);

    expect(document.processingStatus).toBe("FAILED");
    expect(document.processingError).toMatch(/no extractable text/i);
    expect(document.extractedText).toBeNull();
  });

  it("rejects a non-PDF upload before creating any document", async () => {
    const buffer = Buffer.from("just some text, not a pdf");
    const documentsBefore = await prisma.document.count({ where: { courseId } });

    await expect(uploadDocument(courseId, "notes.txt", "text/plain", buffer)).rejects.toThrow(
      UploadValidationError,
    );

    const documentsAfter = await prisma.document.count({ where: { courseId } });
    expect(documentsAfter).toBe(documentsBefore);
  });

  it("enforces ownership when reading or deleting a document", async () => {
    const buffer = await makeTextPdfBuffer("Ownership test content for isolation checks.");
    const document = await uploadDocument(courseId, "owned.pdf", "application/pdf", buffer);

    expect((await getDocumentForUser(user.id, document.id))?.id).toBe(document.id);
    expect(await getDocumentForUser(otherUser.id, document.id)).toBeNull();

    expect(await deleteDocumentForUser(otherUser.id, document.id)).toBe(false);
    expect(await deleteDocumentForUser(user.id, document.id)).toBe(true);
    expect(await getDocumentForUser(user.id, document.id)).toBeNull();
  });
});
