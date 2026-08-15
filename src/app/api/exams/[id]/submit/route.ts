import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { examErrorStatus, submitExam } from "@/lib/exam/exam-orchestrator";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Finalizes the exam server-side (spec §55-56): unanswered questions are
 * graded as UNANSWERED, mistakes are analyzed, the Student Knowledge Model
 * is updated, readiness and the next-best-action are computed. Idempotent
 * — a second call (double-click, retry) on an already-graded exam returns
 * the existing result rather than re-grading or creating a duplicate.
 */
export async function POST(_request: Request, { params }: RouteContext) {
  const { id: examId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:exam-submit`, { maxRequests: 10, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  try {
    const result = await submitExam(examId, user.id);
    return NextResponse.json({ result });
  } catch (error) {
    console.error("Failed to submit exam:", error);
    const { status, message } = examErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
