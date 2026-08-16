import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { retryDocumentIngestion } from "@/lib/services/documents";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Re-runs ingestion for a failed document (Phase 15 §8) — reuses the exact same pipeline the original upload used. */
export async function POST(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const document = await retryDocumentIngestion(user.id, id);
  if (!document) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  return NextResponse.json(document);
}
