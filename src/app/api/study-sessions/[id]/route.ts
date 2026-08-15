import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getSessionState } from "@/lib/learning/study-session";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Reconstructs the session's current state — used on page load/refresh (spec §21). */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id: sessionId } = await params;
  const user = await getCurrentUser();

  const state = await getSessionState(sessionId, user.id);
  if (!state) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }
  return NextResponse.json(state);
}
