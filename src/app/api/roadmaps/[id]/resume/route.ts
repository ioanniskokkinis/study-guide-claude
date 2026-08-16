import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { resumeRoadmap, RoadmapNotFoundError, RoadmapNotPausedError } from "@/lib/advisor/lifecycle";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Resumes a paused roadmap. Never auto-replans — returns a deterministic signal for whether a replan is worth offering (spec §32). */
export async function POST(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  try {
    const result = await resumeRoadmap(user.id, id);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RoadmapNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof RoadmapNotPausedError) return NextResponse.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
