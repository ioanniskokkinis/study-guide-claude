import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getGraphData } from "@/lib/services/knowledge";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const typesParam = request.nextUrl.searchParams.get("types");
  const relationshipTypes = typesParam
    ? typesParam
        .split(",")
        .map((type) => type.trim())
        .filter(Boolean)
    : undefined;

  const graph = await getGraphData(user.id, courseId, relationshipTypes);
  if (!graph) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }

  return NextResponse.json(graph);
}
