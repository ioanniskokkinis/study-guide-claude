import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse } from "@/lib/services/courses";
import { findOwnedFolder } from "@/lib/services/folders";
import { uploadDocumentDeduped } from "@/lib/services/documents";
import { UploadValidationError } from "@/lib/documents/validation";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** One request can contain many files (spec's own "10 files uploaded" example) but not unbounded — keeps a single request's ingestion work and latency bounded. */
const MAX_FILES_PER_BATCH = 30;

type FileResult =
  | { filename: string; status: "created" | "duplicate"; documentId: string }
  | { filename: string; status: "failed"; error: string };

/**
 * Multi-file upload (Phase 15 §2, §6-7, §13-14). Every file is validated,
 * stored, and ingested independently through the exact same pipeline the
 * single-file route uses (uploadDocumentDeduped -> uploadDocument ->
 * processDocument) — no second parser, no second ingestion system. One
 * file's failure never aborts the rest of the batch (spec §6): each result
 * is collected individually and the response is always 200 with a per-file
 * status array, even if every file in the batch failed.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const course = await findOwnedCourse(user.id, courseId);
  if (!course) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }

  const rateLimit = checkRateLimit(`${user.id}:bulk-upload`, { maxRequests: 10, windowMs: 5 * 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many upload requests. Please wait a moment." }, { status: 429 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data with 'files' fields." }, { status: 400 });
  }

  const files = formData.getAll("files").filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided." }, { status: 400 });
  }
  if (files.length > MAX_FILES_PER_BATCH) {
    return NextResponse.json({ error: `A single upload is limited to ${MAX_FILES_PER_BATCH} files.` }, { status: 400 });
  }

  const folderIdRaw = formData.get("folderId");
  let folderId: string | null = null;
  if (typeof folderIdRaw === "string" && folderIdRaw.length > 0) {
    const folder = await findOwnedFolder(user.id, folderIdRaw);
    if (!folder || folder.courseId !== courseId) {
      return NextResponse.json({ error: "Folder not found." }, { status: 404 });
    }
    folderId = folder.id;
  }

  const results: FileResult[] = [];

  for (const file of files) {
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const outcome = await uploadDocumentDeduped(courseId, file.name, file.type, buffer, folderId);
      results.push({ filename: file.name, status: outcome.status, documentId: outcome.document.id });
    } catch (error) {
      const message = error instanceof UploadValidationError ? error.message : "The document could not be uploaded.";
      if (!(error instanceof UploadValidationError)) {
        console.error(`Bulk upload failed for file "${file.name}" in course ${courseId}:`, error);
      }
      results.push({ filename: file.name, status: "failed", error: message });
    }
  }

  return NextResponse.json({ results }, { status: 201 });
}
