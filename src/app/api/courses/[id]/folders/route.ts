import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse } from "@/lib/services/courses";
import { createFolder, listFolders, InvalidFolderMoveError } from "@/lib/services/folders";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const folders = await listFolders(user.id, courseId);
  if (!folders) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }

  return NextResponse.json({ folders });
}

interface CreateFolderBody {
  name?: string;
  parentFolderId?: string | null;
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const course = await findOwnedCourse(user.id, courseId);
  if (!course) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }

  let body: CreateFolderBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.name || typeof body.name !== "string") {
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  }

  try {
    const folder = await createFolder(user.id, courseId, { name: body.name, parentFolderId: body.parentFolderId ?? null });
    return NextResponse.json(folder, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidFolderMoveError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
