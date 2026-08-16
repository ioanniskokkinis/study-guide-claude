import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import {
  createFolder,
  deleteFolder,
  findOwnedFolder,
  InvalidFolderMoveError,
  listFolders,
  moveDocumentToFolder,
  moveFolder,
  renameFolder,
} from "@/lib/services/folders";
import { uploadDocument } from "@/lib/services/documents";
import { makeTextPdfBuffer } from "./fixtures";

/** Phase 15 §3-5, §9, §18 — folder CRUD, nesting, circular/cross-course guards, ownership. */
describe("folders service", () => {
  let userId: string;
  let otherUserId: string;
  let courseId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `folders-${suffix}@example.com` } })).id;
    otherUserId = (await prisma.user.create({ data: { email: `folders-other-${suffix}@example.com` } })).id;
    courseId = (await prisma.course.create({ data: { userId, title: `Folder Course ${suffix}` } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  it("creates a folder scoped to the owning course", async () => {
    const folder = await createFolder(userId, courseId, { name: "01 Algorithms" });
    expect(folder?.courseId).toBe(courseId);
    expect(folder?.name).toBe("01 Algorithms");
  });

  it("returns null when creating a folder in a course the user doesn't own", async () => {
    const folder = await createFolder(otherUserId, courseId, { name: "Nope" });
    expect(folder).toBeNull();
  });

  it("supports nested folders via parentFolderId", async () => {
    const parent = await createFolder(userId, courseId, { name: "Biology" });
    const child = await createFolder(userId, courseId, { name: "Cell Biology", parentFolderId: parent!.id });
    expect(child?.parentFolderId).toBe(parent!.id);
  });

  it("rejects creating a subfolder under a parent from a different course", async () => {
    const otherCourse = await prisma.course.create({ data: { userId, title: "Other course" } });
    const foreignParent = await createFolder(userId, otherCourse.id, { name: "Foreign" });
    await expect(createFolder(userId, courseId, { name: "Child", parentFolderId: foreignParent!.id })).rejects.toBeInstanceOf(
      InvalidFolderMoveError,
    );
  });

  it("renames a folder only when owned by the requesting user", async () => {
    const folder = await createFolder(userId, courseId, { name: "Old name" });
    expect(await renameFolder(userId, folder!.id, "New name")).toBe(true);
    expect(await renameFolder(otherUserId, folder!.id, "Hacked")).toBe(false);
    const reloaded = await findOwnedFolder(userId, folder!.id);
    expect(reloaded?.name).toBe("New name");
  });

  it("rejects moving a folder into itself", async () => {
    const folder = await createFolder(userId, courseId, { name: "Self" });
    await expect(moveFolder(userId, folder!.id, folder!.id)).rejects.toBeInstanceOf(InvalidFolderMoveError);
  });

  it("rejects moving a folder into one of its own descendants (circular move)", async () => {
    const parent = await createFolder(userId, courseId, { name: "Parent A" });
    const child = await createFolder(userId, courseId, { name: "Child A", parentFolderId: parent!.id });
    const grandchild = await createFolder(userId, courseId, { name: "Grandchild A", parentFolderId: child!.id });

    await expect(moveFolder(userId, parent!.id, grandchild!.id)).rejects.toBeInstanceOf(InvalidFolderMoveError);
  });

  it("rejects moving a folder into a folder from a different course", async () => {
    const otherCourse = await prisma.course.create({ data: { userId, title: "Cross-course target" } });
    const target = await createFolder(userId, otherCourse.id, { name: "Target" });
    const folder = await createFolder(userId, courseId, { name: "Mover" });

    await expect(moveFolder(userId, folder!.id, target!.id)).rejects.toBeInstanceOf(InvalidFolderMoveError);
  });

  it("returns false moving a folder not owned by the requesting user", async () => {
    const folder = await createFolder(userId, courseId, { name: "Owned only by userId" });
    expect(await moveFolder(otherUserId, folder!.id, null)).toBe(false);
  });

  it("deletes a folder and cascades to its documents and storage cleanup", async () => {
    const folder = await createFolder(userId, courseId, { name: "To delete" });
    const buffer = await makeTextPdfBuffer("Content for cascade-delete test.");
    const document = await uploadDocument(courseId, "cascade.pdf", "application/pdf", buffer, folder!.id);

    expect(await deleteFolder(userId, folder!.id)).toBe(true);
    expect(await prisma.folder.findUnique({ where: { id: folder!.id } })).toBeNull();
    expect(await prisma.document.findUnique({ where: { id: document.id } })).toBeNull();
  });

  it("returns false deleting a folder not owned by the requesting user", async () => {
    const folder = await createFolder(userId, courseId, { name: "Not yours" });
    expect(await deleteFolder(otherUserId, folder!.id)).toBe(false);
  });

  it("lists folders ordered by position/createdAt, scoped to the owning course", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const freshCourse = await prisma.course.create({ data: { userId, title: `List test ${suffix}` } });
    await createFolder(userId, freshCourse.id, { name: "A" });
    await createFolder(userId, freshCourse.id, { name: "B" });

    const listed = await listFolders(userId, freshCourse.id);
    expect(listed).toHaveLength(2);
    expect(await listFolders(otherUserId, freshCourse.id)).toBeNull();
  });

  it("moves a document into a folder, rejecting a folder from a different course", async () => {
    const buffer = await makeTextPdfBuffer("Movable document content.");
    const document = await uploadDocument(courseId, "movable.pdf", "application/pdf", buffer);
    const folder = await createFolder(userId, courseId, { name: "Destination" });

    expect(await moveDocumentToFolder(userId, document.id, folder!.id)).toBe(true);
    const reloaded = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(reloaded.folderId).toBe(folder!.id);

    const otherCourse = await prisma.course.create({ data: { userId, title: "Cross course doc move" } });
    const foreignFolder = await createFolder(userId, otherCourse.id, { name: "Foreign" });
    await expect(moveDocumentToFolder(userId, document.id, foreignFolder!.id)).rejects.toBeInstanceOf(InvalidFolderMoveError);
  });
});
