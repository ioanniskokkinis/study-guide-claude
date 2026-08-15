import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { recordDecisionResponse } from "@/lib/learning/adaptive-engine";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface PatchBody {
  accepted?: boolean;
}

/** Records whether the student accepted or overrode a recommendation (spec §30-31) — never forces or punishes either choice. */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { id: decisionLogId } = await params;
  const user = await getCurrentUser();

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (typeof body.accepted !== "boolean") {
    return NextResponse.json({ error: "accepted (boolean) is required." }, { status: 400 });
  }

  const updated = await recordDecisionResponse(decisionLogId, user.id, body.accepted);
  if (!updated) {
    return NextResponse.json({ error: "Decision not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
