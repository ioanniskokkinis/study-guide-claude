import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getNextBestAction } from "@/lib/advisor/next-action";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** "What should I study now?" (Phase 16 §18-19) — deterministic, no AI call. */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const action = await getNextBestAction(user.id, id);
  if (!action) {
    return NextResponse.json({ error: "Roadmap not found." }, { status: 404 });
  }
  return NextResponse.json(action);
}
