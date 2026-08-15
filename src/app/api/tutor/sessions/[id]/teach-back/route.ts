import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { requestTeachBack, tutorSessionErrorStatus } from "@/lib/tutor/tutor-orchestrator";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Explicitly switches an in-progress session into TEACH_BACK mode (spec §41, §48). */
export async function POST(_request: Request, { params }: RouteContext) {
  const { id: sessionId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:tutor-teach-back`, { maxRequests: 10, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  try {
    const result = await requestTeachBack(sessionId, user.id);
    return NextResponse.json(result);
  } catch (error) {
    const { status, message } = tutorSessionErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
