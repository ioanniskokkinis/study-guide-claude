import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { checkRateLimit } from "@/lib/rate-limit";
import { replanStudyRoadmap, RoadmapNotActiveError, RoadmapNotFoundError } from "@/lib/advisor/replan";
import { RoadmapGenerationError, InvalidRoadmapInputError } from "@/lib/advisor/roadmap-service";
import { NoScopedConceptsError } from "@/lib/advisor/knowledge-gaps";
import { prisma } from "@/lib/db/prisma";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface SettingsBody {
  deadline?: string | null;
  minutesPerDay?: number;
  studyDays?: number[];
}

function errorStatus(error: unknown): { status: number; message: string } {
  if (error instanceof RoadmapNotFoundError) return { status: 404, message: error.message };
  if (error instanceof RoadmapNotActiveError) return { status: 409, message: error.message };
  if (error instanceof InvalidRoadmapInputError) return { status: 400, message: error.message };
  if (error instanceof NoScopedConceptsError) return { status: 422, message: error.message };
  if (error instanceof RoadmapGenerationError) return { status: 502, message: error.message };
  return { status: 500, message: "Something went wrong." };
}

/**
 * Changes a roadmap's deadline and/or available study time (Phase 16
 * §30-31). Never mutates the current roadmap version in place — both are
 * entry points into replanStudyRoadmap() with an explicit trigger, so the
 * change produces a new version and the old one is preserved exactly as it
 * was (spec §31: "never retroactively change historical study time").
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:roadmap-settings`, { maxRequests: 5, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  let body: SettingsBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!("deadline" in body) && body.minutesPerDay == null && body.studyDays == null) {
    return NextResponse.json({ error: "At least one of deadline, minutesPerDay, or studyDays is required." }, { status: 400 });
  }

  const current = await prisma.studyRoadmap.findFirst({ where: { id, userId: user.id } });
  if (!current) {
    return NextResponse.json({ error: "Roadmap not found." }, { status: 404 });
  }

  const deadlineChanged = "deadline" in body && (body.deadline ? new Date(body.deadline).getTime() : null) !== (current.deadline?.getTime() ?? null);
  const capacityChanged = (body.minutesPerDay != null && body.minutesPerDay !== current.minutesPerDay) || body.studyDays != null;

  const trigger = deadlineChanged ? "DEADLINE_CHANGE" : capacityChanged ? "TIME_AVAILABILITY_CHANGE" : "MANUAL_REPLAN";

  try {
    const roadmap = await replanStudyRoadmap(user.id, id, {
      trigger,
      // Only set the `deadline` key at all when the request body actually included one —
      // replanStudyRoadmap() distinguishes "key present" (an explicit override, possibly null)
      // from "key absent" (keep the roadmap's current deadline) via `"deadline" in options`.
      ...("deadline" in body ? { deadline: body.deadline ? new Date(body.deadline) : null } : {}),
      minutesPerDay: body.minutesPerDay,
      studyDays: body.studyDays,
    });
    return NextResponse.json(roadmap, { status: 201 });
  } catch (error) {
    const { status, message } = errorStatus(error);
    if (status === 500) console.error(`Roadmap settings change failed for roadmap ${id}:`, error);
    return NextResponse.json({ error: message }, { status });
  }
}
