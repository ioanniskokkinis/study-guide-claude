import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { searchDocuments } from "@/lib/services/knowledge-hub-search";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const query = new URL(request.url).searchParams.get("q") ?? "";
  const results = await searchDocuments(user.id, courseId, query);
  if (results === null) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }

  return NextResponse.json({ results });
}
