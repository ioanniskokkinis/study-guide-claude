import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { evaluateSubmittedAnswer, studySessionErrorStatus } from "@/lib/learning/study-session";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface EvaluateBody {
  sessionQuestionId?: string;
}

/**
 * Runs (or retries — idempotently, Phase 17 §18/§37) Claude evaluation for
 * an already-persisted answer, separate from POST .../answer (§13). Always
 * responds 200 with the settled `answer` row: a timeout or evaluation
 * failure is a normal, recoverable outcome here (`answer.evaluationStatus`
 * is TIMEOUT/FAILED), never an HTTP error that would force the client to
 * treat it as unrecoverable (§36/§60).
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { id: sessionId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:evaluate-answer`, { maxRequests: 20, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  let body: EvaluateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body.sessionQuestionId || typeof body.sessionQuestionId !== "string") {
    return NextResponse.json({ error: "sessionQuestionId is required." }, { status: 400 });
  }

  try {
    const result = await evaluateSubmittedAnswer({ sessionId, userId: user.id, sessionQuestionId: body.sessionQuestionId });
    return NextResponse.json(result);
  } catch (error) {
    const { status, message } = studySessionErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
