import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getKnowledgeSummary } from "@/lib/services/knowledge";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const summary = await getKnowledgeSummary(user.id, courseId);
  if (!summary) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }

  return NextResponse.json(summary);
}
