import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getConceptDetail } from "@/lib/services/knowledge";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const concept = await getConceptDetail(user.id, id);
  if (!concept) {
    return NextResponse.json({ error: "Concept not found." }, { status: 404 });
  }

  return NextResponse.json(concept);
}
