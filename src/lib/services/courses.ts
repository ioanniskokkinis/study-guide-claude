import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage/local-storage";

export function listCourses(userId: string) {
  return prisma.course.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { documents: true } } },
  });
}

export function createCourse(userId: string, data: { title: string; description?: string | null }) {
  return prisma.course.create({
    data: {
      userId,
      title: data.title,
      description: data.description ?? null,
    },
  });
}

/** Returns null (rather than throwing) when the course doesn't exist or isn't owned by `userId`. */
export function getCourseWithDocuments(userId: string, courseId: string) {
  return prisma.course.findFirst({
    where: { id: courseId, userId },
    include: {
      documents: {
        orderBy: { createdAt: "asc" },
        // Internal storage details never leave the server (spec §10, §13).
        omit: { storagePath: true, filename: true },
        include: { _count: { select: { chunks: true } } },
      },
    },
  });
}

export function findOwnedCourse(userId: string, courseId: string) {
  return prisma.course.findFirst({ where: { id: courseId, userId } });
}

/** Returns false if the course doesn't exist or isn't owned by `userId`. */
export async function deleteCourse(userId: string, courseId: string): Promise<boolean> {
  const course = await prisma.course.findFirst({
    where: { id: courseId, userId },
    include: { documents: { select: { storagePath: true } } },
  });

  if (!course) {
    return false;
  }

  await prisma.course.delete({ where: { id: courseId } });

  await Promise.all(
    course.documents.map((document) =>
      storage.delete(document.storagePath).catch((error) => {
        console.error(`Failed to delete stored file ${document.storagePath}:`, error);
      }),
    ),
  );

  return true;
}
