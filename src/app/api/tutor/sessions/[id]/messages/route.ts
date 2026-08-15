import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { submitTutorMessage, tutorSessionErrorStatus } from "@/lib/tutor/tutor-orchestrator";
import { CONFIDENCE_LEVELS, type ConfidenceLevel } from "@/lib/tutor/types";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface SubmitMessageBody {
  content?: string;
  /** Optional self-report (spec §29) — used to detect illusion of competence, never required. */
  confidence?: string;
}

function isConfidenceLevel(value: unknown): value is ConfidenceLevel {
  return typeof value === "string" && (CONFIDENCE_LEVELS as readonly string[]).includes(value);
}

/**
 * Submits the student's next message and returns the tutor's response
 * (spec §39, §41). Idempotency note (spec §57): each call creates one new
 * STUDENT + one new TUTOR message — a client-side retry of an identical
 * request is not deduplicated server-side (there is no natural idempotency
 * key for free-text chat turns), so the UI should disable the input while a
 * request is in flight rather than relying on the server to collapse
 * duplicates.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { id: sessionId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:tutor-message`, { maxRequests: 30, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  let body: SubmitMessageBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.content || typeof body.content !== "string") {
    return NextResponse.json({ error: "content is required." }, { status: 400 });
  }

  try {
    const result = await submitTutorMessage({
      sessionId,
      userId: user.id,
      content: body.content,
      confidence: isConfidenceLevel(body.confidence) ? body.confidence : null,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to process tutor message:", error);
    const { status, message } = tutorSessionErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
