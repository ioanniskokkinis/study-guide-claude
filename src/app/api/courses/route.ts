import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { createCourse, listCourses } from "@/lib/services/courses";

export async function GET() {
  const user = await getCurrentUser();
  const courses = await listCourses(user.id);
  return NextResponse.json(courses);
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const title = typeof (body as { title?: unknown })?.title === "string" ? (body as { title: string }).title.trim() : "";
  const descriptionRaw = (body as { description?: unknown })?.description;
  const description = typeof descriptionRaw === "string" ? descriptionRaw : null;

  if (title.length === 0) {
    return NextResponse.json({ error: "A course title is required." }, { status: 400 });
  }

  const course = await createCourse(user.id, { title, description });
  return NextResponse.json(course, { status: 201 });
}
