import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getNextLearningAction, NoConceptsAvailableError } from "@/lib/learning/adaptive-engine";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * The adaptive engine's "what should I study next?" endpoint (spec §26,
 * §49). Deterministic, zero Claude calls — every recommendation comes from
 * PostgreSQL via getStudentLearningState() and the scoring functions in
 * src/lib/learning/adaptive/. Ownership is verified inside the engine
 * itself (the course lookup in getStudentLearningState is scoped to
 * `userId`), never trusting a client-supplied id.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  try {
    const { action, decisionLogId } = await getNextLearningAction({ userId: user.id, courseId });
    return NextResponse.json({ action, decisionLogId });
  } catch (error) {
    if (error instanceof NoConceptsAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    console.error("Failed to compute next learning action:", error);
    return NextResponse.json({ error: "Could not compute a recommendation right now." }, { status: 500 });
  }
}
