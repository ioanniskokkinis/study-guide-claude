import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { searchConcepts } from "@/lib/services/knowledge";
import { parsePositiveIntParam } from "@/lib/api/query-params";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get("q") ?? undefined;
  const page = parsePositiveIntParam(searchParams.get("page")) ?? 1;
  const pageSize = parsePositiveIntParam(searchParams.get("pageSize")) ?? 20;

  const result = await searchConcepts(user.id, courseId, { query, page, pageSize });

  if (!result) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }

  return NextResponse.json(result);
}
