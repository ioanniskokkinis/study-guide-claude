import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getExamState } from "@/lib/exam/exam-orchestrator";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Reconstructs exam state for resume (spec §17) — server-computed remaining time, never trusts a client timer (spec §16, §55). */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id: examId } = await params;
  const user = await getCurrentUser();

  const state = await getExamState(examId, user.id);
  if (!state) {
    return NextResponse.json({ error: "Exam not found." }, { status: 404 });
  }
  return NextResponse.json(state);
}
