import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { searchConcepts } from "@/lib/services/knowledge";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get("q") ?? undefined;
  const page = Number(searchParams.get("page") ?? "1");
  const pageSize = Number(searchParams.get("pageSize") ?? "20");

  const result = await searchConcepts(user.id, courseId, {
    query,
    page: Number.isFinite(page) ? page : 1,
    pageSize: Number.isFinite(pageSize) ? pageSize : 20,
  });

  if (!result) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }

  return NextResponse.json(result);
}
