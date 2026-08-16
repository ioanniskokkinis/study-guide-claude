import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { checkRateLimit } from "@/lib/rate-limit";
import { createStudyRoadmap, InvalidRoadmapInputError, RoadmapGenerationError } from "@/lib/advisor/roadmap-service";
import { InvalidScopeError } from "@/lib/advisor/scope";
import { NoScopedConceptsError } from "@/lib/advisor/knowledge-gaps";
import { listRoadmaps } from "@/lib/advisor/queries";
import type { StudyRoadmapScopeType } from "@/generated/prisma/client";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const roadmaps = await listRoadmaps(user.id, courseId);
  if (roadmaps === null) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }
  return NextResponse.json({ roadmaps });
}

interface CreateRoadmapBody {
  goal?: string;
  targetScore?: number | null;
  deadline?: string | null;
  minutesPerDay?: number;
  studyDays?: number[];
  scopeType?: StudyRoadmapScopeType;
  folderId?: string | null;
  documentIds?: string[];
}

function errorStatus(error: unknown): { status: number; message: string } {
  if (error instanceof InvalidRoadmapInputError) return { status: 400, message: error.message };
  if (error instanceof InvalidScopeError) return { status: 400, message: error.message };
  if (error instanceof NoScopedConceptsError) return { status: 422, message: error.message };
  if (error instanceof RoadmapGenerationError) return { status: 502, message: error.message };
  return { status: 500, message: "Something went wrong." };
}

/**
 * Creates a new Study Advisor roadmap (Phase 15 §22, §27). The only route
 * in this feature that calls the AI — every other roadmap read is a plain
 * DB query (spec §52).
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:roadmap-create`, { maxRequests: 5, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  let body: CreateRoadmapBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.goal || typeof body.goal !== "string") {
    return NextResponse.json({ error: "goal is required." }, { status: 400 });
  }
  if (typeof body.minutesPerDay !== "number") {
    return NextResponse.json({ error: "minutesPerDay is required." }, { status: 400 });
  }
  if (!body.scopeType) {
    return NextResponse.json({ error: "scopeType is required." }, { status: 400 });
  }

  try {
    const roadmap = await createStudyRoadmap(user.id, {
      courseId,
      goal: body.goal,
      targetScore: body.targetScore ?? null,
      deadline: body.deadline ? new Date(body.deadline) : null,
      minutesPerDay: body.minutesPerDay,
      studyDays: body.studyDays ?? [],
      scope: { scopeType: body.scopeType, folderId: body.folderId ?? null, documentIds: body.documentIds ?? [] },
    });
    return NextResponse.json(roadmap, { status: 201 });
  } catch (error) {
    const { status, message } = errorStatus(error);
    if (status === 500) console.error(`Roadmap creation failed for course ${courseId}:`, error);
    return NextResponse.json({ error: message }, { status });
  }
}
