import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { nextReviewQuestion, reviewErrorStatus } from "@/lib/review/review-orchestrator";

export const runtime = "nodejs";
export const maxDuration = 120;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Advances to the next due-but-not-yet-asked concept in this review session. */
export async function POST(_request: Request, { params }: RouteContext) {
  const { id: sessionId } = await params;
  const user = await getCurrentUser();

  try {
    const result = await nextReviewQuestion(sessionId, user.id);
    return NextResponse.json(result);
  } catch (error) {
    const { status, message } = reviewErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
