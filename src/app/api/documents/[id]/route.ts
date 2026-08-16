import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { deleteDocumentForUser, getDocumentForUser, renameDocument } from "@/lib/services/documents";
import { moveDocumentToFolder, InvalidFolderMoveError } from "@/lib/services/folders";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const document = await getDocumentForUser(user.id, id);
  if (!document) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  return NextResponse.json(document);
}

interface PatchBody {
  originalFilename?: string;
  /** Absent = leave folder unchanged; null = move to the course root; string = move into that folder. */
  folderId?: string | null;
}

/** Renames and/or moves a document into a different folder (Phase 15 §9). Server-side ownership + same-course folder checks — never trusts the client's folder assertion. */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof body.originalFilename === "string" && body.originalFilename.trim().length > 0) {
    const renamed = await renameDocument(user.id, id, body.originalFilename);
    if (!renamed) {
      return NextResponse.json({ error: "Document not found." }, { status: 404 });
    }
  }

  if ("folderId" in body) {
    try {
      const moved = await moveDocumentToFolder(user.id, id, body.folderId ?? null);
      if (!moved) {
        return NextResponse.json({ error: "Document not found." }, { status: 404 });
      }
    } catch (error) {
      if (error instanceof InvalidFolderMoveError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
  }

  const document = await getDocumentForUser(user.id, id);
  return NextResponse.json(document);
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const deleted = await deleteDocumentForUser(user.id, id);
  if (!deleted) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
