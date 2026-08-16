import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { checkRateLimit } from "@/lib/rate-limit";
import { replanStudyRoadmap, RoadmapNotActiveError, RoadmapNotFoundError } from "@/lib/advisor/replan";
import { RoadmapGenerationError } from "@/lib/advisor/roadmap-service";
import { NoScopedConceptsError } from "@/lib/advisor/knowledge-gaps";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

function errorStatus(error: unknown): { status: number; message: string } {
  if (error instanceof RoadmapNotFoundError) return { status: 404, message: error.message };
  if (error instanceof RoadmapNotActiveError) return { status: 409, message: error.message };
  if (error instanceof NoScopedConceptsError) return { status: 422, message: error.message };
  if (error instanceof RoadmapGenerationError) return { status: 502, message: error.message };
  return { status: 500, message: "Something went wrong." };
}

/** Replans an active roadmap (Phase 15 §37) — creates a new versioned roadmap, never mutates the old one. */
export async function POST(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:roadmap-replan`, { maxRequests: 5, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  try {
    const roadmap = await replanStudyRoadmap(user.id, id);
    return NextResponse.json(roadmap, { status: 201 });
  } catch (error) {
    const { status, message } = errorStatus(error);
    if (status === 500) console.error(`Replan failed for roadmap ${id}:`, error);
    return NextResponse.json({ error: message }, { status });
  }
}
