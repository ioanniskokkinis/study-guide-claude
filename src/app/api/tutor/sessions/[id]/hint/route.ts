import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { requestTutorHint, tutorSessionErrorStatus } from "@/lib/tutor/tutor-orchestrator";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Proactive hint request (spec §41, §22-23) — escalates one level (HINT_1 -> HINT_2 -> HINT_3 -> REVEAL), never skipping ahead. */
export async function POST(_request: Request, { params }: RouteContext) {
  const { id: sessionId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:tutor-hint`, { maxRequests: 20, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  try {
    const result = await requestTutorHint(sessionId, user.id);
    return NextResponse.json(result);
  } catch (error) {
    const { status, message } = tutorSessionErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
