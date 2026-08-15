import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getRecentMistakes } from "@/lib/services/student-knowledge";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const searchParams = request.nextUrl.searchParams;
  const limitParam = searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;
  const unresolvedOnly = searchParams.get("unresolvedOnly") === "true";

  const mistakes = await getRecentMistakes(user.id, courseId, {
    limit: Number.isFinite(limit) ? limit : undefined,
    unresolvedOnly,
  });
  if (!mistakes) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }

  return NextResponse.json({ mistakes });
}
