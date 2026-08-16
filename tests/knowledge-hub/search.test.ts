import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { uploadDocument } from "@/lib/services/documents";
import { createFolder } from "@/lib/services/folders";
import { searchDocuments } from "@/lib/services/knowledge-hub-search";
import { makeTextPdfBuffer } from "./fixtures";

/** Phase 15 §15 — basic filename/folder/course search, no semantic search system. */
describe("searchDocuments", () => {
  let userId: string;
  let otherUserId: string;
  let courseId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `search-${suffix}@example.com` } })).id;
    otherUserId = (await prisma.user.create({ data: { email: `search-other-${suffix}@example.com` } })).id;
    courseId = (await prisma.course.create({ data: { userId, title: `Search Course ${suffix}` } })).id;

    const folder = await createFolder(userId, courseId, { name: "Exams" });
    const buffer = await makeTextPdfBuffer("Search fixture content.");
    await uploadDocument(courseId, "Midterm Review.pdf", "application/pdf", buffer, folder!.id);
    await uploadDocument(courseId, "Lecture Notes.pdf", "application/pdf", buffer);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  it("finds a document by a case-insensitive filename substring", async () => {
    const results = await searchDocuments(userId, courseId, "midterm");
    expect(results).not.toBeNull();
    expect(results!.some((r) => r.originalFilename === "Midterm Review.pdf")).toBe(true);
    expect(results!.every((r) => r.originalFilename !== "Lecture Notes.pdf")).toBe(true);
  });

  it("includes the folder name in results for documents inside a folder", async () => {
    const results = await searchDocuments(userId, courseId, "midterm");
    expect(results![0].folderName).toBe("Exams");
  });

  it("returns every document when the query is empty", async () => {
    const results = await searchDocuments(userId, courseId, "");
    expect(results!.length).toBeGreaterThanOrEqual(2);
  });

  it("returns null for a course the requester doesn't own", async () => {
    expect(await searchDocuments(otherUserId, courseId, "midterm")).toBeNull();
  });

  it("never returns results from another course", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const otherCourseId = (await prisma.course.create({ data: { userId, title: `Isolated ${suffix}` } })).id;
    const results = await searchDocuments(userId, otherCourseId, "midterm");
    expect(results).toEqual([]);
  });
});
