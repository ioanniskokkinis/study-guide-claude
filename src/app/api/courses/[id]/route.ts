import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { deleteCourse, getCourseWithDocuments } from "@/lib/services/courses";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const course = await getCourseWithDocuments(user.id, id);
  if (!course) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }

  return NextResponse.json(course);
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const deleted = await deleteCourse(user.id, id);
  if (!deleted) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
