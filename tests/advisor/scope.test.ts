import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { resolveStudyScope, InvalidScopeError } from "@/lib/advisor/scope";
import { seedCourseWithConcepts } from "./fixtures";

/** Phase 15 §11, §18-19, §21-23 — material scope resolution. */
describe("resolveStudyScope", () => {
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `scope-${suffix}@example.com` } })).id;
    otherUserId = (await prisma.user.create({ data: { email: `scope-other-${suffix}@example.com` } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  it("COURSE scope includes every concept in the course", async () => {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 4 });
    const scope = await resolveStudyScope(userId, course.id, { scopeType: "COURSE" });
    expect(scope.conceptIds.sort()).toEqual(concepts.map((c) => c.id).sort());
  });

  it("FOLDER scope includes only concepts sourced from documents in that folder", async () => {
    const { course, folder, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 3, withFolder: true });
    // A second, unrelated folder+document+concept in the same course must NOT leak in.
    const other = await seedCourseWithConcepts(userId, { courseTitle: course.title, conceptCount: 1 });

    const scope = await resolveStudyScope(userId, course.id, { scopeType: "FOLDER", folderId: folder!.id });
    expect(scope.conceptIds.sort()).toEqual(concepts.map((c) => c.id).sort());
    expect(scope.conceptIds).not.toContain(other.concepts[0].id);
  });

  it("FOLDER scope includes documents from nested subfolders", async () => {
    const { course, folder, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1, withFolder: true });
    const subfolder = await prisma.folder.create({ data: { courseId: course.id, parentFolderId: folder!.id, name: "Sub" } });
    const subDoc = await prisma.document.create({
      data: {
        courseId: course.id,
        folderId: subfolder.id,
        filename: "sub.pdf",
        originalFilename: "sub.pdf",
        mimeType: "application/pdf",
        fileSize: 1,
        type: "pdf",
        storagePath: "x/sub.pdf",
        processingStatus: "READY",
      },
    });
    const subChunk = await prisma.documentChunk.create({ data: { documentId: subDoc.id, text: "t", chunkIndex: 0, tokenCount: 1 } });
    const subConcept = await prisma.concept.create({ data: { courseId: course.id, name: "Sub Concept", normalizedName: "sub-concept" } });
    await prisma.conceptSource.create({ data: { conceptId: subConcept.id, documentChunkId: subChunk.id, evidence: "e" } });

    const scope = await resolveStudyScope(userId, course.id, { scopeType: "FOLDER", folderId: folder!.id });
    expect(scope.conceptIds).toContain(concepts[0].id);
    expect(scope.conceptIds).toContain(subConcept.id);
  });

  it("DOCUMENTS scope includes only concepts sourced from the selected documents", async () => {
    const { course, document, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 2 });
    const other = await seedCourseWithConcepts(userId, { courseTitle: course.title, conceptCount: 1 });

    const scope = await resolveStudyScope(userId, course.id, { scopeType: "DOCUMENTS", documentIds: [document.id] });
    expect(scope.conceptIds.sort()).toEqual(concepts.map((c) => c.id).sort());
    expect(scope.conceptIds).not.toContain(other.concepts[0].id);
    expect(scope.documentIds).toEqual([document.id]);
  });

  it("rejects an unowned course", async () => {
    const { course } = await seedCourseWithConcepts(userId);
    await expect(resolveStudyScope(otherUserId, course.id, { scopeType: "COURSE" })).rejects.toBeInstanceOf(InvalidScopeError);
  });

  it("rejects a FOLDER scope pointing at another course's folder", async () => {
    const a = await seedCourseWithConcepts(userId, { withFolder: true });
    const b = await seedCourseWithConcepts(userId);
    await expect(resolveStudyScope(userId, b.course.id, { scopeType: "FOLDER", folderId: a.folder!.id })).rejects.toBeInstanceOf(
      InvalidScopeError,
    );
  });

  it("rejects a DOCUMENTS scope with a document from another course", async () => {
    const a = await seedCourseWithConcepts(userId);
    const b = await seedCourseWithConcepts(userId);
    await expect(
      resolveStudyScope(userId, b.course.id, { scopeType: "DOCUMENTS", documentIds: [a.document.id] }),
    ).rejects.toBeInstanceOf(InvalidScopeError);
  });

  it("rejects a DOCUMENTS scope with no documents selected", async () => {
    const { course } = await seedCourseWithConcepts(userId);
    await expect(resolveStudyScope(userId, course.id, { scopeType: "DOCUMENTS", documentIds: [] })).rejects.toBeInstanceOf(
      InvalidScopeError,
    );
  });
});
