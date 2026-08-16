import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage/local-storage";

/**
 * Knowledge Hub folder management (Phase 15 §3-5, §9, §18). Every function
 * takes `userId` first and re-derives ownership from the folder's own
 * `courseId -> course.userId` relation before doing anything — the same
 * "never trust a client-asserted id" pattern this codebase has used since
 * Phase 1 (see src/lib/services/documents.ts's own ownership checks).
 */

export class FolderNotFoundError extends Error {
  constructor() {
    super("Folder not found.");
  }
}

export class InvalidFolderMoveError extends Error {}

function sanitizeFolderName(name: string): string {
  const trimmed = name.trim().slice(0, 200);
  return trimmed.length > 0 ? trimmed : "Untitled folder";
}

/** Returns null if the folder doesn't exist or isn't owned by `userId` (via its course). */
export function findOwnedFolder(userId: string, folderId: string) {
  return prisma.folder.findFirst({ where: { id: folderId, course: { userId } } });
}

export async function createFolder(
  userId: string,
  courseId: string,
  input: { name: string; parentFolderId?: string | null },
) {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId } });
  if (!course) return null;

  if (input.parentFolderId) {
    const parent = await prisma.folder.findFirst({ where: { id: input.parentFolderId, courseId } });
    if (!parent) throw new InvalidFolderMoveError("The parent folder does not belong to this course.");
  }

  return prisma.folder.create({
    data: {
      courseId,
      parentFolderId: input.parentFolderId ?? null,
      name: sanitizeFolderName(input.name),
    },
  });
}

/** Returns null if the course doesn't exist or isn't owned by `userId`. */
export async function listFolders(userId: string, courseId: string) {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId } });
  if (!course) return null;

  return prisma.folder.findMany({
    where: { courseId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    include: { _count: { select: { documents: true, childFolders: true } } },
  });
}

/** Returns false if the folder doesn't exist or isn't owned by `userId`. */
export async function renameFolder(userId: string, folderId: string, name: string): Promise<boolean> {
  const result = await prisma.folder.updateMany({
    where: { id: folderId, course: { userId } },
    data: { name: sanitizeFolderName(name) },
  });
  return result.count > 0;
}

/**
 * All descendant folder ids of `folderId`, `folderId` itself included, via
 * BFS over a course's full folder set (small enough per course to load
 * once — spec §5: not built for unlimited/enterprise-scale trees). Exported
 * so the Study Advisor's scope resolution (src/lib/advisor/scope.ts) can
 * reuse the exact same subtree definition a FOLDER-scoped roadmap needs,
 * rather than a second, possibly-diverging implementation.
 */
export async function collectFolderSubtreeIds(courseId: string, folderId: string): Promise<Set<string>> {
  const allFolders = await prisma.folder.findMany({ where: { courseId }, select: { id: true, parentFolderId: true } });
  const childrenByParent = new Map<string, string[]>();
  for (const f of allFolders) {
    if (!f.parentFolderId) continue;
    const list = childrenByParent.get(f.parentFolderId) ?? [];
    list.push(f.id);
    childrenByParent.set(f.parentFolderId, list);
  }

  const subtree = new Set<string>([folderId]);
  const queue = [folderId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const childId of childrenByParent.get(current) ?? []) {
      if (subtree.has(childId)) continue;
      subtree.add(childId);
      queue.push(childId);
    }
  }
  return subtree;
}

/**
 * Moves a folder under a new parent (or to the course root when
 * `newParentFolderId` is null). Rejects: moving a folder into itself or any
 * of its own descendants (spec §5's circular-relationship guard), and
 * moving into a folder belonging to a different course (courses are
 * isolated — spec §5). Returns false if the folder doesn't exist or isn't
 * owned by `userId`.
 */
export async function moveFolder(userId: string, folderId: string, newParentFolderId: string | null): Promise<boolean> {
  const folder = await findOwnedFolder(userId, folderId);
  if (!folder) return false;

  if (newParentFolderId === folderId) {
    throw new InvalidFolderMoveError("A folder cannot be moved inside itself.");
  }

  if (newParentFolderId) {
    const newParent = await prisma.folder.findFirst({ where: { id: newParentFolderId, courseId: folder.courseId } });
    if (!newParent) {
      throw new InvalidFolderMoveError("The destination folder does not belong to the same course.");
    }
    const subtree = await collectFolderSubtreeIds(folder.courseId, folderId);
    if (subtree.has(newParentFolderId)) {
      throw new InvalidFolderMoveError("A folder cannot be moved into one of its own subfolders.");
    }
  }

  const result = await prisma.folder.updateMany({
    where: { id: folderId, course: { userId } },
    data: { parentFolderId: newParentFolderId },
  });
  return result.count > 0;
}

/**
 * Deletes a folder and its full subtree (child folders + their documents —
 * spec §9's "deletion must be safe" is satisfied by deleting DB rows inside
 * one transaction first, then best-effort cleaning up storage files
 * afterward, exactly like deleteCourse()/deleteDocumentForUser() already
 * do — a storage-delete failure never leaves an inconsistent DB). Returns
 * false if the folder doesn't exist or isn't owned by `userId`.
 */
export async function deleteFolder(userId: string, folderId: string): Promise<boolean> {
  const folder = await findOwnedFolder(userId, folderId);
  if (!folder) return false;

  const subtreeIds = await collectFolderSubtreeIds(folder.courseId, folderId);
  const documentsToDelete = await prisma.document.findMany({
    where: { folderId: { in: Array.from(subtreeIds) } },
    select: { storagePath: true },
  });

  await prisma.folder.delete({ where: { id: folderId } });

  await Promise.all(
    documentsToDelete.map((document) =>
      storage.delete(document.storagePath).catch((error) => {
        console.error(`Failed to delete stored file ${document.storagePath}:`, error);
      }),
    ),
  );

  return true;
}

/**
 * Moves a document into a folder (or to the course root when `folderId` is
 * null). Rejects moving into a folder belonging to a different course.
 * Returns false if the document doesn't exist or isn't owned by `userId`.
 */
export async function moveDocumentToFolder(userId: string, documentId: string, folderId: string | null): Promise<boolean> {
  const document = await prisma.document.findFirst({ where: { id: documentId, course: { userId } } });
  if (!document) return false;

  if (folderId) {
    const folder = await prisma.folder.findFirst({ where: { id: folderId, courseId: document.courseId } });
    if (!folder) {
      throw new InvalidFolderMoveError("The destination folder does not belong to the same course.");
    }
  }

  const result = await prisma.document.updateMany({
    where: { id: documentId, course: { userId } },
    data: { folderId },
  });
  return result.count > 0;
}
