import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { startTutorSession, tutorSessionErrorStatus } from "@/lib/tutor/tutor-orchestrator";
import { TUTOR_MODES, type TutorModeValue } from "@/lib/tutor/types";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

interface StartTutorSessionBody {
  courseId?: string;
  conceptId?: string;
  mode?: string;
}

function isTutorMode(value: unknown): value is TutorModeValue {
  return typeof value === "string" && (TUTOR_MODES as readonly string[]).includes(value);
}

/** Starts a new tutor conversation (spec §42). Course/concept ownership is verified inside the orchestrator, never trusted from the request. */
export async function POST(request: Request) {
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:tutor-session-start`, { maxRequests: 10, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  let body: StartTutorSessionBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.courseId || typeof body.courseId !== "string") {
    return NextResponse.json({ error: "courseId is required." }, { status: 400 });
  }
  if (!body.conceptId || typeof body.conceptId !== "string") {
    return NextResponse.json({ error: "conceptId is required." }, { status: 400 });
  }
  const mode: TutorModeValue = isTutorMode(body.mode) ? body.mode : "SOCRATIC";

  try {
    const result = await startTutorSession({ userId: user.id, courseId: body.courseId, conceptId: body.conceptId, mode });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const { status, message } = tutorSessionErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
