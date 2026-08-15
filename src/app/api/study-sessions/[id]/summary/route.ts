import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getSessionSummary } from "@/lib/learning/study-session";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { id: sessionId } = await params;
  const user = await getCurrentUser();

  const summary = await getSessionSummary(sessionId, user.id);
  if (!summary) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }
  return NextResponse.json(summary);
}
