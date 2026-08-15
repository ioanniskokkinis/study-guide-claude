import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getExamResult } from "@/lib/exam/exam-orchestrator";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Post-exam analysis (spec §37-39, §43, §63): score, concept/cognitive breakdown, mistakes, and per-question feedback — only available once the exam has been graded. */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id: examId } = await params;
  const user = await getCurrentUser();

  const result = await getExamResult(examId, user.id);
  if (!result) {
    return NextResponse.json({ error: "Exam result not available yet." }, { status: 404 });
  }
  return NextResponse.json({ result });
}
