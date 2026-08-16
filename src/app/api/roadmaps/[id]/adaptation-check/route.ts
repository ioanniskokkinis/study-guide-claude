import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { checkAdaptationNeeded, RoadmapNotFoundForCheckError } from "@/lib/advisor/change-detection";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Deterministic significant-change detection (Phase 16 §21-22) — never
 * calls the AI, and never writes anything (a GET stays read-only): the
 * "since when" window this check uses is anchored to `lastEvaluatedAt`,
 * which is only ever updated when a roadmap is actually (re)generated
 * (`createStudyRoadmap` stamps it), never by merely checking. Only detects
 * and reports whether a replan is worth offering; applying one is always a
 * separate, explicit action (spec §28).
 */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  try {
    const result = await checkAdaptationNeeded(user.id, id);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RoadmapNotFoundForCheckError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
