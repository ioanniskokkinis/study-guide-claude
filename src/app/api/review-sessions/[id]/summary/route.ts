import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getReviewSessionSummary } from "@/lib/review/review-orchestrator";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { id: sessionId } = await params;
  const user = await getCurrentUser();

  const summary = await getReviewSessionSummary(sessionId, user.id);
  if (!summary) {
    return NextResponse.json({ error: "Review session not found." }, { status: 404 });
  }
  return NextResponse.json(summary);
}
