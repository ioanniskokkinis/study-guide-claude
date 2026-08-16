import { prisma } from "@/lib/db/prisma";

/**
 * Plain, deterministic reads over already-persisted roadmap data (Phase 15
 * §52) — never call the AI here. A roadmap page load is DB -> render, not
 * DB -> AI -> render.
 */

/** Returns null if the roadmap doesn't exist or isn't owned by `userId`. */
export function getRoadmap(userId: string, roadmapId: string) {
  return prisma.studyRoadmap.findFirst({
    where: { id: roadmapId, userId },
    include: {
      weeks: { orderBy: { weekNumber: "asc" }, include: { items: { orderBy: { scheduledDate: "asc" } } } },
      scopeFolder: { select: { id: true, name: true } },
      scopeDocuments: { include: { document: { select: { id: true, originalFilename: true } } } },
      replacesRoadmap: { select: { id: true, version: true, createdAt: true } },
      replacedBy: { select: { id: true, version: true, createdAt: true } },
    },
  });
}

/** Returns null if the course doesn't exist or isn't owned by `userId`. */
export async function listRoadmaps(userId: string, courseId: string) {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId } });
  if (!course) return null;

  return prisma.studyRoadmap.findMany({
    where: { userId, courseId },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, goal: true, status: true, deadline: true, startDate: true, endDate: true, version: true, createdAt: true },
  });
}

/**
 * "What do I do today?" (spec §33) — every item scheduled for today, plus
 * anything overdue (scheduledDate in the past, still PENDING) so nothing
 * silently falls off the plan. Returns null if the roadmap doesn't exist or
 * isn't owned by `userId`.
 */
export async function getTodayPlan(userId: string, roadmapId: string) {
  const roadmap = await prisma.studyRoadmap.findFirst({ where: { id: roadmapId, userId } });
  if (!roadmap) return null;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday);
  endOfToday.setHours(23, 59, 59, 999);

  const [today, overdue] = await Promise.all([
    prisma.studyRoadmapItem.findMany({
      where: { roadmapId, scheduledDate: { gte: startOfToday, lte: endOfToday } },
      orderBy: { priority: "desc" },
    }),
    prisma.studyRoadmapItem.findMany({
      where: { roadmapId, status: "PENDING", scheduledDate: { lt: startOfToday } },
      orderBy: { scheduledDate: "asc" },
    }),
  ]);

  return { today, overdue };
}
