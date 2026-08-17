import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getRecentMistakes } from "@/lib/services/student-knowledge";
import { parsePositiveIntParam } from "@/lib/api/query-params";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const searchParams = request.nextUrl.searchParams;
  const limit = parsePositiveIntParam(searchParams.get("limit"));
  const unresolvedOnly = searchParams.get("unresolvedOnly") === "true";

  const mistakes = await getRecentMistakes(user.id, courseId, { limit, unresolvedOnly });
  if (!mistakes) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }

  return NextResponse.json({ mistakes });
}
