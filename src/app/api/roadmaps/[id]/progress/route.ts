import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getRoadmapProgress } from "@/lib/advisor/progress";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Pure DB read — no AI call (spec §39, §52). */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const progress = await getRoadmapProgress(user.id, id);
  if (!progress) {
    return NextResponse.json({ error: "Roadmap not found." }, { status: 404 });
  }
  return NextResponse.json(progress);
}
