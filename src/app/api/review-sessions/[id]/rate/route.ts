import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { submitReviewRating, reviewErrorStatus } from "@/lib/review/review-orchestrator";
import type { ReviewOutcome } from "@/generated/prisma/client";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface RateBody {
  sessionQuestionId?: string;
  outcome?: string;
}

/** Self-rated recall quality (AGAIN/HARD/GOOD/EASY) — reschedules the underlying ReviewItem. Idempotent: retrying with the same already-answered question returns the original result rather than rescheduling twice (spec §21). */
export async function POST(request: Request, { params }: RouteContext) {
  const { id: sessionId } = await params;
  const user = await getCurrentUser();

  let body: RateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body.sessionQuestionId || typeof body.sessionQuestionId !== "string" || !body.outcome) {
    return NextResponse.json({ error: "sessionQuestionId and outcome are required." }, { status: 400 });
  }

  try {
    const result = await submitReviewRating({
      sessionId,
      userId: user.id,
      sessionQuestionId: body.sessionQuestionId,
      outcome: body.outcome as ReviewOutcome,
    });
    return NextResponse.json(result);
  } catch (error) {
    const { status, message } = reviewErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
