import { prisma } from "@/lib/db/prisma";
import type { LearningGoalType } from "@/generated/prisma/client";

/**
 * Basic goal model (spec §15) — deliberately not a full calendar planner.
 * Consumed by the adaptive engine's calculateGoalRelevanceScore(); a goal
 * with no targetConceptIds applies to the whole course.
 */

export interface CreateLearningGoalInput {
  type: LearningGoalType;
  targetDate?: Date | null;
  targetConceptIds?: string[] | null;
  priority?: number;
}

/** Returns null if the course doesn't exist or isn't owned by `userId`. */
export async function createLearningGoal(userId: string, courseId: string, input: CreateLearningGoalInput) {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId } });
  if (!course) return null;

  return prisma.learningGoal.create({
    data: {
      userId,
      courseId,
      type: input.type,
      targetDate: input.targetDate ?? null,
      targetConceptIds: input.targetConceptIds && input.targetConceptIds.length > 0 ? input.targetConceptIds : undefined,
      priority: input.priority ?? 1,
    },
  });
}

/** Returns null if the course doesn't exist or isn't owned by `userId`. */
export async function getLearningGoals(userId: string, courseId: string) {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId } });
  if (!course) return null;

  return prisma.learningGoal.findMany({ where: { userId, courseId }, orderBy: { createdAt: "desc" } });
}

/** Returns false if the goal doesn't exist or isn't owned by `userId`. */
export async function deleteLearningGoal(userId: string, goalId: string): Promise<boolean> {
  const result = await prisma.learningGoal.deleteMany({ where: { id: goalId, userId } });
  return result.count > 0;
}
