import { getCurrentUser } from "@/lib/auth/dev-user";
import { streamTutorMessage, tutorSessionErrorStatus, type TutorStreamEvent } from "@/lib/tutor/tutor-orchestrator";
import { CONFIDENCE_LEVELS, type ConfidenceLevel } from "@/lib/tutor/types";
import { checkRateLimit } from "@/lib/rate-limit";
import { createSseStream, SSE_HEADERS } from "@/lib/http/sse";

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
 * Submits the student's next message and streams the tutor's response back
 * as Server-Sent Events (Phase 11): `start` as soon as the deterministic
 * decision is known, `delta` for each generated text chunk (Claude-generated
 * actions only — non-AI actions like TEACH_BACK/COMPLETE go straight to
 * `complete`, spec §6), `metadata` with latency instrumentation, then
 * `complete` with the persisted session/message, or `error` if generation
 * fails. Rate limiting and request validation still happen synchronously
 * before any streaming begins (spec §9), so a disallowed or malformed
 * request still gets a plain JSON response exactly as before Phase 11.
 *
 * Idempotency note (spec §57, preserved from the pre-streaming route):
 * each call creates one new STUDENT + one new TUTOR message — a client-side
 * retry of an identical request is not deduplicated server-side (there is
 * no natural idempotency key for free-text chat turns), so the UI disables
 * the input while a request is in flight rather than relying on the server
 * to collapse duplicates.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { id: sessionId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:tutor-message`, { maxRequests: 30, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return Response.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  let body: SubmitMessageBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.content || typeof body.content !== "string") {
    return Response.json({ error: "content is required." }, { status: 400 });
  }

  const content = body.content;
  const confidence = isConfidenceLevel(body.confidence) ? body.confidence : null;
  const signal = request.signal;

  const stream = createSseStream<TutorStreamEvent>(streamTutorMessage({ sessionId, userId: user.id, content, confidence, signal }), (error) => {
    console.error("Failed to stream tutor message:", error);
    return { type: "error", message: tutorSessionErrorStatus(error).message };
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
