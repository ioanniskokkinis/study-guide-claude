import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getOrStartReviewSession, reviewErrorStatus } from "@/lib/review/review-orchestrator";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Starts a new review session on the most-overdue due concept, or resumes an in-progress one. */
export async function POST(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:review-session-start`, { maxRequests: 5, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  try {
    const state = await getOrStartReviewSession(user.id, courseId);
    if (!state) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }
    return NextResponse.json(state);
  } catch (error) {
    const { status, message } = reviewErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
