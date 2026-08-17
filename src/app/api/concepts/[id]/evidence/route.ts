import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getConceptEvidence } from "@/lib/services/student-knowledge";
import { parsePositiveIntParam } from "@/lib/api/query-params";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { id: conceptId } = await params;
  const user = await getCurrentUser();

  const limit = parsePositiveIntParam(request.nextUrl.searchParams.get("limit"));

  const evidence = await getConceptEvidence(user.id, conceptId, { limit });
  if (!evidence) {
    return NextResponse.json({ error: "Concept not found." }, { status: 404 });
  }

  return NextResponse.json({ evidence });
}
