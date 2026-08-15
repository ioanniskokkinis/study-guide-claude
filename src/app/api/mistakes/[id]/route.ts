import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { resolveMistake } from "@/lib/services/student-knowledge";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Marks a mistake reviewed. This is a review-tracking action only — it
 * never changes mastery (spec §23); mastery only moves on new evidence via
 * recordLearningOutcome.
 */
export async function PATCH(_request: Request, { params }: RouteContext) {
  const { id: mistakeId } = await params;
  const user = await getCurrentUser();

  const mistake = await resolveMistake(user.id, mistakeId);
  if (!mistake) {
    return NextResponse.json({ error: "Mistake not found." }, { status: 404 });
  }

  return NextResponse.json(mistake);
}
