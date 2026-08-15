import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getDocumentChunks, getDocumentForUser } from "@/lib/services/documents";
import { statusLabel } from "@/components/documents/status-label";
import { formatBytes } from "@/lib/format";

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
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href={`/courses/${courseId}`}
        className="text-sm text-zinc-500 hover:underline"
      >
        ← {document.course.title}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        {document.originalFilename}
      </h1>

      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800 sm:grid-cols-3">
        <Field label="Status">
          <span className={status.className}>{status.label}</span>
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
          {document.extractedText
            ? `${document.extractedText.length.toLocaleString()} characters`
            : "—"}
        </Field>
        <Field label="Chunks">{document._count.chunks}</Field>
      </dl>

      {document.processingError && (
        <p className="mt-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {document.processingError}
        </p>
      )}

      {document.extractedText && (
        <div className="mt-8">
          <h2 className="text-sm font-medium text-zinc-500">Extracted text</h2>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-200 p-4 text-sm text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
            {document.extractedText}
          </pre>
        </div>
      )}

      {chunks.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-medium text-zinc-500">
            Chunks ({chunks.length})
          </h2>
          <ul className="mt-2 space-y-2">
            {chunks.map((chunk) => (
              <li
                key={chunk.id}
                className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800"
              >
                <p className="text-xs font-medium text-zinc-400">
                  Chunk {chunk.chunkIndex} · ~{chunk.tokenCount} tokens
                </p>
                <p className="mt-1 line-clamp-3 text-zinc-700 dark:text-zinc-300">
                  {chunk.text}
                </p>
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
      <dt className="text-xs text-zinc-400">{label}</dt>
      <dd className="mt-0.5 font-medium text-zinc-900 dark:text-zinc-50">{children}</dd>
    </div>
  );
}
