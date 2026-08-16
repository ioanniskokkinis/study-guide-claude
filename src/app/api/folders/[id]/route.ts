import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { deleteFolder, findOwnedFolder, moveFolder, renameFolder, InvalidFolderMoveError } from "@/lib/services/folders";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const folder = await findOwnedFolder(user.id, id);
  if (!folder) {
    return NextResponse.json({ error: "Folder not found." }, { status: 404 });
  }
  return NextResponse.json(folder);
}

interface PatchBody {
  name?: string;
  /** Absent = leave parent unchanged; null = move to the course root; string = move under that folder. */
  parentFolderId?: string | null;
}

/** Renames and/or moves a folder (Phase 15 §5, §9). Circular/cross-course moves are rejected server-side by moveFolder(). */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  try {
    if (typeof body.name === "string" && body.name.trim().length > 0) {
      const renamed = await renameFolder(user.id, id, body.name);
      if (!renamed) {
        return NextResponse.json({ error: "Folder not found." }, { status: 404 });
      }
    }

    if ("parentFolderId" in body) {
      const moved = await moveFolder(user.id, id, body.parentFolderId ?? null);
      if (!moved) {
        return NextResponse.json({ error: "Folder not found." }, { status: 404 });
      }
    }
  } catch (error) {
    if (error instanceof InvalidFolderMoveError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const folder = await findOwnedFolder(user.id, id);
  return NextResponse.json(folder);
}

/** Deletes a folder and everything inside it (Phase 15 §9) — the client must confirm before calling this, same convention as course/document deletion. */
export async function DELETE(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const deleted = await deleteFolder(user.id, id);
  if (!deleted) {
    return NextResponse.json({ error: "Folder not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
