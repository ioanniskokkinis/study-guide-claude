import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { deleteLearningGoal } from "@/lib/services/learning-goals";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { id: goalId } = await params;
  const user = await getCurrentUser();

  const deleted = await deleteLearningGoal(user.id, goalId);
  if (!deleted) {
    return NextResponse.json({ error: "Goal not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
