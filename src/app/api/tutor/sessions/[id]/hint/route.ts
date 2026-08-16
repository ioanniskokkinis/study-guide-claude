import { streamTutorHint, tutorSessionErrorStatus, type TutorStreamEvent } from "@/lib/tutor/tutor-orchestrator";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { checkRateLimit } from "@/lib/rate-limit";
import { createSseStream, SSE_HEADERS } from "@/lib/http/sse";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Proactive hint request (spec §41, §22-23) — escalates one level (HINT_1
 * -> HINT_2 -> HINT_3 -> REVEAL), never skipping ahead. Streams the hint
 * back as Server-Sent Events using the same protocol and infrastructure as
 * `/messages` and session start (Phase 13 §4) — no new Claude call, no
 * change to the escalation logic above.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { id: sessionId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:tutor-hint`, { maxRequests: 20, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return Response.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  const signal = request.signal;
  const stream = createSseStream<TutorStreamEvent>(streamTutorHint(sessionId, user.id, signal), (error) => {
    console.error("Failed to stream tutor hint:", error);
    return { type: "error", message: tutorSessionErrorStatus(error).message };
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
