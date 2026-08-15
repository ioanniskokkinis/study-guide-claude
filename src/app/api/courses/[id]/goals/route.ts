import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { createLearningGoal, getLearningGoals } from "@/lib/services/learning-goals";
import type { LearningGoalType } from "@/generated/prisma/client";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const VALID_GOAL_TYPES: readonly LearningGoalType[] = ["EXAM", "MASTER_COURSE", "CERTIFICATION", "GENERAL"];

function isGoalType(value: string): value is LearningGoalType {
  return (VALID_GOAL_TYPES as readonly string[]).includes(value);
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const goals = await getLearningGoals(user.id, courseId);
  if (!goals) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }
  return NextResponse.json({ goals });
}

interface CreateGoalBody {
  type?: string;
  targetDate?: string;
  targetConceptIds?: string[];
  priority?: number;
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  let body: CreateGoalBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.type || !isGoalType(body.type)) {
    return NextResponse.json({ error: `type must be one of ${VALID_GOAL_TYPES.join(", ")}.` }, { status: 400 });
  }
  const goalType = body.type;

  let targetDate: Date | null = null;
  if (body.targetDate) {
    targetDate = new Date(body.targetDate);
    if (Number.isNaN(targetDate.getTime())) {
      return NextResponse.json({ error: "targetDate must be a valid date." }, { status: 400 });
    }
  }

  const goal = await createLearningGoal(user.id, courseId, {
    type: goalType,
    targetDate,
    targetConceptIds: Array.isArray(body.targetConceptIds) ? body.targetConceptIds : null,
    priority: typeof body.priority === "number" ? body.priority : undefined,
  });
  if (!goal) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }
  return NextResponse.json(goal, { status: 201 });
}
