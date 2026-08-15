import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getActiveReviewSessionId } from "@/lib/review/review-orchestrator";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** No-AI-call check for an in-progress review session, so the UI can silently resume on page load (spec §21 equivalent for review). */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const sessionId = await getActiveReviewSessionId(user.id, courseId);
  return NextResponse.json({ sessionId });
}
