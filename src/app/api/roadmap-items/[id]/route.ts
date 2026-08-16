import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { updateRoadmapItemStatus } from "@/lib/advisor/progress";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const VALID_STATUSES = ["PENDING", "IN_PROGRESS", "COMPLETED", "SKIPPED"] as const;

export async function PATCH(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  let body: { status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.status || !(VALID_STATUSES as readonly string[]).includes(body.status)) {
    return NextResponse.json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }, { status: 400 });
  }

  const updated = await updateRoadmapItemStatus(user.id, id, body.status as (typeof VALID_STATUSES)[number]);
  if (!updated) {
    return NextResponse.json({ error: "Roadmap item not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
