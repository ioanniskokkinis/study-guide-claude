import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { retryDocumentIngestion } from "@/lib/services/documents";
import { checkRateLimit } from "@/lib/rate-limit";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Re-runs ingestion for a failed document (Phase 15 §8) — reuses the exact same pipeline the original upload used. */
export async function POST(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  // Phase 19 §19.15 — re-runs the same PDF-processing pipeline as upload.
  const rateLimit = checkRateLimit(`${user.id}:document-retry`, { maxRequests: 20, windowMs: 5 * 60_000 });
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  const document = await retryDocumentIngestion(user.id, id);
  if (!document) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  return NextResponse.json(document);
}
