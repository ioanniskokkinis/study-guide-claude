import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { nextQuestion, studySessionErrorStatus } from "@/lib/learning/study-session";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface NextBody {
  retry?: boolean;
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id: sessionId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:next-question`, { maxRequests: 30, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  let body: NextBody = {};
  try {
    body = await request.json();
  } catch {
    // No body is fine — retry defaults to false.
  }

  try {
    const result = await nextQuestion({ sessionId, userId: user.id, retry: body.retry === true });
    return NextResponse.json(result);
  } catch (error) {
    const { status, message } = studySessionErrorStatus(error);
    return NextResponse.json({ error: message }, { status });
  }
}
