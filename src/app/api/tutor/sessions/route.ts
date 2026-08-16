import { getCurrentUser } from "@/lib/auth/dev-user";
import { prepareTutorSessionStart, streamTutorSessionStart, tutorSessionErrorStatus, type TutorStreamEvent } from "@/lib/tutor/tutor-orchestrator";
import { TUTOR_MODES, type TutorModeValue } from "@/lib/tutor/types";
import { checkRateLimit } from "@/lib/rate-limit";
import { createSseStream, SSE_HEADERS } from "@/lib/http/sse";

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

/**
 * Starts or resumes a tutor conversation (spec §42). Course/concept
 * ownership is verified inside the orchestrator, never trusted from the
 * request.
 *
 * Two distinct response shapes, decided *before* any bytes are written
 * (Phase 13 §3): resuming an already-active session has nothing to
 * generate — it's a plain DB read — so it returns plain JSON `{session,
 * messages}` exactly as before Phase 13. Starting a fresh session streams
 * the opening question as Server-Sent Events using the same protocol as
 * `/messages`, with the same rate limit and validation gating it stream
 * or not.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:tutor-session-start`, { maxRequests: 10, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return Response.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  let body: StartTutorSessionBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.courseId || typeof body.courseId !== "string") {
    return Response.json({ error: "courseId is required." }, { status: 400 });
  }
  if (!body.conceptId || typeof body.conceptId !== "string") {
    return Response.json({ error: "conceptId is required." }, { status: 400 });
  }
  const mode: TutorModeValue = isTutorMode(body.mode) ? body.mode : "SOCRATIC";

  const requestStartedAt = Date.now();
  let outcome: Awaited<ReturnType<typeof prepareTutorSessionStart>>;
  try {
    outcome = await prepareTutorSessionStart({ userId: user.id, courseId: body.courseId, conceptId: body.conceptId, mode });
  } catch (error) {
    const { status, message } = tutorSessionErrorStatus(error);
    return Response.json({ error: message }, { status });
  }
  const decisionMs = Date.now() - requestStartedAt;

  if (outcome.kind === "resumed") {
    return Response.json(outcome.result, { status: 200 });
  }

  const signal = request.signal;
  const stream = createSseStream<TutorStreamEvent>(
    streamTutorSessionStart(outcome.prepared, { requestStartedAt, decisionMs }, signal),
    (error) => {
      console.error("Failed to stream tutor session start:", error);
      return { type: "error", message: tutorSessionErrorStatus(error).message };
    },
  );

  return new Response(stream, { status: 201, headers: SSE_HEADERS });
}
