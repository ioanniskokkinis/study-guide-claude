import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getRoadmapHealthForRoadmap } from "@/lib/advisor/health";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Deterministic — no AI call, pure DB read + arithmetic (Phase 16 §40, §45). */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const health = await getRoadmapHealthForRoadmap(user.id, id);
  if (!health) {
    return NextResponse.json({ error: "Roadmap not found." }, { status: 404 });
  }
  return NextResponse.json(health);
}
