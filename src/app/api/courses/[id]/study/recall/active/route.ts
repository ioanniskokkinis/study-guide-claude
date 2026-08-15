import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getActiveSessionId } from "@/lib/learning/study-session";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** No-AI-call check for an in-progress session, so the UI can silently resume on page load rather than always showing "Start" (spec §21). */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const sessionId = await getActiveSessionId(user.id, courseId);
  return NextResponse.json({ sessionId });
}
