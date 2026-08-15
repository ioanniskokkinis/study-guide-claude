import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getOrStartSession, studySessionErrorStatus } from "@/lib/learning/study-session";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Starts a new Active Recall session for this course, or resumes an in-progress one (spec §21/§26). */
export async function POST(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:recall-session-start`, { maxRequests: 5, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  try {
    const state = await getOrStartSession(user.id, courseId);
    if (!state) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }
    return NextResponse.json(state);
  } catch (error) {
    const { status, message } = studySessionErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
