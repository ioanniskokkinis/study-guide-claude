import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getDocumentChunks, getDocumentForUser } from "@/lib/services/documents";
import { statusLabel, statusTone } from "@/components/documents/status-label";
import { formatBytes } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { InlineError } from "@/components/ui/ErrorState";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; documentId: string }>;
}

export default async function DocumentPage({ params }: PageProps) {
  const { id: courseId, documentId } = await params;
  const user = await getCurrentUser();
  const document = await getDocumentForUser(user.id, documentId);

  if (!document) {
    notFound();
  }

  const chunks =
    document.processingStatus === "READY" ? await getDocumentChunks(documentId) : [];
  const status = statusLabel(document.processingStatus);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <Link href={`/courses/${courseId}`} className="focus-ring text-sm text-fg-muted hover:text-fg hover:underline">
        ← {document.course.title}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">{document.originalFilename}</h1>

      <Card className="mt-6">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-3">
          <Field label="Status">
            <Badge tone={statusTone(document.processingStatus)}>{status.label}</Badge>
          </Field>
          <Field label="File size">{formatBytes(document.fileSize)}</Field>
          <Field label="Pages">{document.pageCount ?? "—"}</Field>
          <Field label="Uploaded">
            {new Date(document.createdAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </Field>
          <Field label="Extracted text">
            {document.extractedText ? `${document.extractedText.length.toLocaleString()} characters` : "—"}
          </Field>
          <Field label="Chunks">{document._count.chunks}</Field>
        </dl>
      </Card>

      {document.processingError && (
        <div className="mt-4">
          <InlineError message={document.processingError} />
        </div>
      )}

      {document.extractedText && (
        <div className="mt-8">
          <SectionHeader title="Extracted text" />
          <pre className="mt-2 max-h-96 overflow-auto rounded-lg border border-border bg-surface-muted p-4 text-sm whitespace-pre-wrap text-fg-muted">
            {document.extractedText}
          </pre>
        </div>
      )}

      {chunks.length > 0 && (
        <div className="mt-8">
          <SectionHeader title={`Chunks (${chunks.length})`} />
          <ul className="mt-2 space-y-2">
            {chunks.map((chunk) => (
              <li key={chunk.id} className="rounded-lg border border-border p-3 text-sm">
                <p className="text-xs font-medium text-fg-subtle">
                  Chunk {chunk.chunkIndex} · ~{chunk.tokenCount} tokens
                </p>
                <p className="mt-1 line-clamp-3 text-fg-muted">{chunk.text}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 font-medium text-fg">{children}</dd>
    </div>
  );
}
