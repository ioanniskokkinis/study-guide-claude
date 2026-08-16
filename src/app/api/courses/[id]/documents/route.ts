import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse, getCourseWithDocuments } from "@/lib/services/courses";
import { uploadDocument } from "@/lib/services/documents";
import { UploadValidationError } from "@/lib/documents/validation";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Used by the Knowledge Hub UI to refresh its document list after a mutation, without a full page navigation. */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const course = await getCourseWithDocuments(user.id, courseId);
  if (!course) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }

  return NextResponse.json({ documents: course.documents });
}

export async function POST(request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const course = await findOwnedCourse(user.id, courseId);
  if (!course) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data with a 'file' field." }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const document = await uploadDocument(courseId, file.name, file.type, buffer);
    return NextResponse.json(document, { status: 201 });
  } catch (error) {
    if (error instanceof UploadValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Document upload failed:", error);
    return NextResponse.json({ error: "The document could not be uploaded." }, { status: 500 });
  }
}
