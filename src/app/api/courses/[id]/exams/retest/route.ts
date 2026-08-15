import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { createRetest, examErrorStatus, toStudentFacingQuestion } from "@/lib/exam/exam-orchestrator";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface RetestBody {
  conceptIds?: string[];
}

/** Targeted retest on weak concepts only (spec §46) — fresh questions guaranteed via the same per-user reuse exclusion exam-generator.ts already applies. */
export async function POST(request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:exam-retest`, { maxRequests: 5, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  let body: RetestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!Array.isArray(body.conceptIds) || body.conceptIds.length === 0) {
    return NextResponse.json({ error: "conceptIds is required." }, { status: 400 });
  }

  try {
    const exam = await createRetest(user.id, courseId, body.conceptIds);
    return NextResponse.json({ exam: { ...exam, questions: exam.questions.map(toStudentFacingQuestion) } }, { status: 201 });
  } catch (error) {
    const { status, message } = examErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
