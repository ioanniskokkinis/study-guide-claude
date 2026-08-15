import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getConceptEvidence } from "@/lib/services/student-knowledge";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { id: conceptId } = await params;
  const user = await getCurrentUser();

  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;

  const evidence = await getConceptEvidence(user.id, conceptId, { limit: Number.isFinite(limit) ? limit : undefined });
  if (!evidence) {
    return NextResponse.json({ error: "Concept not found." }, { status: 404 });
  }

  return NextResponse.json({ evidence });
}
