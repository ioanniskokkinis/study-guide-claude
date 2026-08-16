import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getKnowledgeProgress } from "@/lib/services/knowledge";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Live knowledge graph build status (production-hardening phase §A4) — a
 * cheap DB read, safe to poll every ~1500ms from the client. Never calls
 * the AI itself.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const progress = await getKnowledgeProgress(user.id, courseId);
  if (!progress) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }
  return NextResponse.json(progress);
}
