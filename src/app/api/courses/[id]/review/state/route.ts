import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getReviewState } from "@/lib/review/review-queries";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Due/overdue counts, next review date, and streak (spec §16) — the summary the course page and review page both show. No AI calls. */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const state = await getReviewState(user.id, courseId);
  if (!state) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }
  return NextResponse.json(state);
}
