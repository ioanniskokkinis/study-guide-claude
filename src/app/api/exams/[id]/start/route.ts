import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { examErrorStatus, startExam, toStudentFacingQuestion } from "@/lib/exam/exam-orchestrator";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Transitions CREATED -> ACTIVE and starts the server-side clock (spec §16-17). Idempotent while ACTIVE — returns the current question rather than erroring on a second call. */
export async function POST(_request: Request, { params }: RouteContext) {
  const { id: examId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:exam-start`, { maxRequests: 10, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  try {
    const { exam, question } = await startExam(examId, user.id);
    return NextResponse.json({ exam, question: question ? toStudentFacingQuestion(question) : null });
  } catch (error) {
    const { status, message } = examErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
