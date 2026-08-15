import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getTutorSessionState } from "@/lib/tutor/tutor-orchestrator";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Reconstructs a tutor session's full conversation — safe to call after any page refresh (spec §20). */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id: sessionId } = await params;
  const user = await getCurrentUser();

  const state = await getTutorSessionState(sessionId, user.id);
  if (!state) {
    return NextResponse.json({ error: "Tutor session not found." }, { status: 404 });
  }
  return NextResponse.json(state);
}
