import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { KnowledgeBuildInProgressError, triggerKnowledgeBuild } from "@/lib/services/knowledge";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Accepts a knowledge graph build and returns immediately (production-
 * hardening phase §A1) — the actual pipeline runs unawaited server-side;
 * the client polls GET .../knowledge/progress for live status instead of
 * this request staying open. Returns 409 if a build is already
 * QUEUED/PROCESSING for this course (§L).
 */
export async function POST(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  try {
    const result = await triggerKnowledgeBuild(user.id, courseId);
    if (!result) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }
    return NextResponse.json({ status: "QUEUED" }, { status: 202 });
  } catch (error) {
    if (error instanceof KnowledgeBuildInProgressError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Knowledge graph build request failed:", error);
    return NextResponse.json({ error: "The knowledge graph could not be built." }, { status: 500 });
  }
}
