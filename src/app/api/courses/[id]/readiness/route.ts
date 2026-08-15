import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { calculateReadiness } from "@/lib/exam/exam-readiness";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** ExamReadinessEngine (spec §40-42, §66 dashboard) — deterministic, no Claude calls. */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();
  const readiness = await calculateReadiness(user.id, courseId);
  return NextResponse.json({ readiness });
}
