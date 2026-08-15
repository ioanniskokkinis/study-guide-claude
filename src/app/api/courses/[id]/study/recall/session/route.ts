import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getOrStartSession, startSessionForConcept, studySessionErrorStatus } from "@/lib/learning/study-session";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface StartSessionBody {
  /** "Study something else" (spec §30) — overrides the adaptive engine's own concept choice. */
  conceptId?: string;
}

/** Starts a new Active Recall session for this course, or resumes an in-progress one (spec §21/§26). Optionally targets a student-chosen concept instead of the adaptive engine's recommendation. */
export async function POST(request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:recall-session-start`, { maxRequests: 5, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  let body: StartSessionBody = {};
  try {
    body = await request.json();
  } catch {
    // No body is fine — defaults to the adaptive engine's own recommendation.
  }

  try {
    const state =
      body.conceptId && typeof body.conceptId === "string"
        ? await startSessionForConcept(user.id, courseId, body.conceptId)
        : await getOrStartSession(user.id, courseId);
    if (!state) {
      return NextResponse.json({ error: "Course or concept not found." }, { status: 404 });
    }
    return NextResponse.json(state);
  } catch (error) {
    const { status, message } = studySessionErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
