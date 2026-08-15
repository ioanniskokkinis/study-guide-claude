import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { submitAnswer, studySessionErrorStatus } from "@/lib/learning/study-session";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface SubmitAnswerBody {
  sessionQuestionId?: string;
  answerText?: string;
  confidence?: number;
  durationSeconds?: number;
}

/**
 * Evaluates a student's answer and updates their mastery. Never trusts a
 * client-supplied userId — ownership of the session and question is
 * re-verified server-side (spec §36).
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { id: sessionId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:submit-answer`, { maxRequests: 20, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  let body: SubmitAnswerBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.sessionQuestionId || typeof body.sessionQuestionId !== "string") {
    return NextResponse.json({ error: "sessionQuestionId is required." }, { status: 400 });
  }
  if (typeof body.answerText !== "string") {
    return NextResponse.json({ error: "answerText is required." }, { status: 400 });
  }

  try {
    const result = await submitAnswer({
      sessionId,
      userId: user.id,
      sessionQuestionId: body.sessionQuestionId,
      answerText: body.answerText,
      confidence: typeof body.confidence === "number" ? body.confidence : null,
      durationSeconds: typeof body.durationSeconds === "number" ? body.durationSeconds : null,
    });
    return NextResponse.json(result);
  } catch (error) {
    const { status, message } = studySessionErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
