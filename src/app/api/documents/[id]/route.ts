import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { deleteDocumentForUser, getDocumentForUser } from "@/lib/services/documents";

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

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const deleted = await deleteDocumentForUser(user.id, id);
  if (!deleted) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
