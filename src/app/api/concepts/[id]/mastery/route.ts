import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getMastery, getPrerequisiteStatus } from "@/lib/services/student-knowledge";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { id: conceptId } = await params;
  const user = await getCurrentUser();

  const [mastery, prerequisites] = await Promise.all([
    getMastery(user.id, conceptId),
    getPrerequisiteStatus(user.id, conceptId),
  ]);

  if (!mastery) {
    return NextResponse.json({ error: "Concept not found." }, { status: 404 });
  }

  return NextResponse.json({ mastery, prerequisites: prerequisites?.prerequisites ?? [] });
}
