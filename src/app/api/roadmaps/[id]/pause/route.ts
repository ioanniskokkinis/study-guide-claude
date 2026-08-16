import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { pauseRoadmap, RoadmapNotFoundError, RoadmapNotResumableError } from "@/lib/advisor/lifecycle";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  try {
    const roadmap = await pauseRoadmap(user.id, id);
    return NextResponse.json(roadmap);
  } catch (error) {
    if (error instanceof RoadmapNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof RoadmapNotResumableError) return NextResponse.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
