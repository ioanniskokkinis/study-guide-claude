import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { rankWeakConcepts } from "@/lib/learning/weak-concepts";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** The full deterministic weak-concept ranking (Phase 2 §C) — see src/lib/learning/weak-concepts.ts for the scoring. */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const ranked = await rankWeakConcepts(user.id, courseId);
  if (ranked === null) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }
  return NextResponse.json({ weakConcepts: ranked });
}
