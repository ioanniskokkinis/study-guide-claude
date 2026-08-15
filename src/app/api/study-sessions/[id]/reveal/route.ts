import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { revealAnswer, studySessionErrorStatus } from "@/lib/learning/study-session";
import { checkRateLimit } from "@/lib/rate-limit";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface RevealBody {
  sessionQuestionId?: string;
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id: sessionId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:reveal`, { maxRequests: 20, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  let body: RevealBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body.sessionQuestionId || typeof body.sessionQuestionId !== "string") {
    return NextResponse.json({ error: "sessionQuestionId is required." }, { status: 400 });
  }

  try {
    const result = await revealAnswer({ sessionId, userId: user.id, sessionQuestionId: body.sessionQuestionId });
    return NextResponse.json(result);
  } catch (error) {
    const { status, message } = studySessionErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
