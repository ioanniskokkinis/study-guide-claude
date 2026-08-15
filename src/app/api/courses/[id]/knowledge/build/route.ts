import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { KnowledgeBuildInProgressError, triggerKnowledgeBuild } from "@/lib/services/knowledge";

export const runtime = "nodejs";
export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  try {
    const summary = await triggerKnowledgeBuild(user.id, courseId);
    if (!summary) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }
    return NextResponse.json(summary);
  } catch (error) {
    if (error instanceof KnowledgeBuildInProgressError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Knowledge graph build request failed:", error);
    return NextResponse.json({ error: "The knowledge graph could not be built." }, { status: 500 });
  }
}
