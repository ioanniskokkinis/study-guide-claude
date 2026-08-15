import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { examErrorStatus, submitExamAnswer } from "@/lib/exam/exam-orchestrator";
import { EXAM_CONFIDENCE_LEVELS, type ExamConfidenceLevelValue } from "@/lib/exam/types";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface SubmitAnswerBody {
  questionId?: string;
  answerText?: string;
  selectedOptionIds?: string[];
  confidence?: string;
  timeSpentSeconds?: number;
  hintsUsed?: number;
  revealedAnswer?: boolean;
}

function isConfidenceLevel(value: unknown): value is ExamConfidenceLevelValue {
  return typeof value === "string" && (EXAM_CONFIDENCE_LEVELS as readonly string[]).includes(value);
}

/**
 * Saves and eagerly grades one answer (spec §18-20) — never reveals the
 * grade to the client here; classification/score/feedback only surface
 * after the whole exam is submitted (spec §14, §63). Upserts by
 * questionId, so re-submitting the same question before final submission
 * safely overwrites the prior answer rather than erroring.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { id: examId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:exam-answer`, { maxRequests: 40, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  let body: SubmitAnswerBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.questionId || typeof body.questionId !== "string") {
    return NextResponse.json({ error: "questionId is required." }, { status: 400 });
  }

  try {
    const result = await submitExamAnswer({
      examId,
      userId: user.id,
      questionId: body.questionId,
      answerText: body.answerText ?? null,
      selectedOptionIds: Array.isArray(body.selectedOptionIds) ? body.selectedOptionIds : null,
      confidence: isConfidenceLevel(body.confidence) ? body.confidence : null,
      timeSpentSeconds: typeof body.timeSpentSeconds === "number" ? body.timeSpentSeconds : undefined,
      hintsUsed: typeof body.hintsUsed === "number" ? body.hintsUsed : undefined,
      revealedAnswer: body.revealedAnswer ?? undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to submit exam answer:", error);
    const { status, message } = examErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
