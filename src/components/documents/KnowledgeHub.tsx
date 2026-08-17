"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { statusLabel, statusTone } from "@/components/documents/status-label";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { InlineError } from "@/components/ui/ErrorState";

interface FolderData {
  id: string;
  name: string;
  parentFolderId: string | null;
  _count: { documents: number; childFolders: number };
}

interface DocumentData {
  id: string;
  originalFilename: string;
  processingStatus: string;
  processingError: string | null;
  folderId: string | null;
  _count: { chunks: number };
}

type UploadRowStatus = "uploading" | "created" | "duplicate" | "failed";

interface UploadRow {
  key: string;
  filename: string;
  status: UploadRowStatus;
  error?: string;
}

/**
 * The Knowledge Hub (Phase 15 Part A) — folder tree navigation, multi-file
 * drag & drop upload with per-file status, bulk actions, and search, all
 * against the folder/document API routes added this phase. Replaces the
 * single-file UploadPdfForm + flat document list that previously lived
 * directly on the course page (Phase 2).
 */
export function KnowledgeHub({
  courseId,
  initialFolders,
  initialDocuments,
}: {
  courseId: string;
  initialFolders: FolderData[];
  initialDocuments: DocumentData[];
}) {
  const router = useRouter();
  const [folders, setFolders] = useState(initialFolders);
  const [documents, setDocuments] = useState(initialDocuments);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploadRows, setUploadRows] = useState<UploadRow[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<(DocumentData & { folderName: string | null }) [] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [foldersRes, documentsRes] = await Promise.all([
      fetch(`/api/courses/${courseId}/folders`),
      fetch(`/api/courses/${courseId}/documents`),
    ]);
    if (foldersRes.ok) setFolders((await foldersRes.json()).folders);
    if (documentsRes.ok) setDocuments((await documentsRes.json()).documents);
    router.refresh();
  }, [courseId, router]);

  useEffect(() => {
    if (!searchQuery.trim()) return;
    const handle = setTimeout(async () => {
      const response = await fetch(`/api/courses/${courseId}/documents/search?q=${encodeURIComponent(searchQuery)}`);
      if (response.ok) {
        const body = await response.json();
        setSearchResults(body.results);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [searchQuery, courseId]);

  function handleSearchChange(value: string) {
    setSearchQuery(value);
    if (!value.trim()) setSearchResults(null);
  }

  const childFolders = useMemo(() => folders.filter((f) => f.parentFolderId === currentFolderId), [folders, currentFolderId]);
  const folderDocuments = useMemo(() => documents.filter((d) => d.folderId === currentFolderId), [documents, currentFolderId]);

  const breadcrumb = useMemo(() => {
    const chain: FolderData[] = [];
    let cursor = currentFolderId;
    while (cursor) {
      const folder = folders.find((f) => f.id === cursor);
      if (!folder) break;
      chain.unshift(folder);
      cursor = folder.parentFolderId;
    }
    return chain;
  }, [currentFolderId, folders]);

  async function uploadFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    setError(null);
    setIsUploading(true);
    setUploadRows(files.map((f) => ({ key: `${f.name}-${f.size}-${Math.random()}`, filename: f.name, status: "uploading" })));

    const formData = new FormData();
    for (const file of files) formData.append("files", file);
    if (currentFolderId) formData.append("folderId", currentFolderId);

    try {
      const response = await fetch(`/api/courses/${courseId}/documents/bulk`, { method: "POST", body: formData });
      const body = await response.json().catch(() => ({ results: [] }));
      if (!response.ok) {
        setError(body.error ?? "Upload failed.");
        setUploadRows((rows) => rows.map((r) => ({ ...r, status: "failed", error: body.error })));
      } else {
        const results: Array<{ filename: string; status: UploadRowStatus; error?: string }> = body.results;
        setUploadRows((rows) =>
          rows.map((row, i) => ({ ...row, status: results[i]?.status ?? "failed", error: results[i]?.error })),
        );
      }
      await refresh();
    } catch {
      setError("Upload failed. Please check your connection and try again.");
      setUploadRows((rows) => rows.map((r) => ({ ...r, status: "failed" })));
    } finally {
      setIsUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCreateFolder() {
    if (!newFolderName.trim()) return;
    const response = await fetch(`/api/courses/${courseId}/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newFolderName, parentFolderId: currentFolderId }),
    });
    if (response.ok) {
      setNewFolderName("");
      setNewFolderOpen(false);
      await refresh();
    } else {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not create folder.");
    }
  }

  async function handleDeleteFolder(folderId: string) {
    if (!confirm("Delete this folder and everything inside it? This cannot be undone.")) return;
    const response = await fetch(`/api/folders/${folderId}`, { method: "DELETE" });
    if (response.ok) await refresh();
  }

  async function handleRenameFolder(folderId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    await fetch(`/api/folders/${folderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    await refresh();
  }

  async function handleRetry(documentId: string) {
    await fetch(`/api/documents/${documentId}/retry`, { method: "POST" });
    await refresh();
  }

  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} document(s)? This cannot be undone.`)) return;
    await Promise.all(Array.from(selected).map((id) => fetch(`/api/documents/${id}`, { method: "DELETE" })));
    setSelected(new Set());
    await refresh();
  }

  async function bulkMove(folderId: string | null) {
    if (selected.size === 0) return;
    await Promise.all(
      Array.from(selected).map((id) =>
        fetch(`/api/documents/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folderId }),
        }),
      ),
    );
    setSelected(new Set());
    await refresh();
  }

  async function bulkRetry() {
    if (selected.size === 0) return;
    await Promise.all(Array.from(selected).map((id) => fetch(`/api/documents/${id}/retry`, { method: "POST" })));
    setSelected(new Set());
    await refresh();
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <button
            type="button"
            onClick={() => setCurrentFolderId(null)}
            className={`focus-ring rounded-md px-1 ${currentFolderId === null ? "font-medium text-fg" : "text-fg-muted hover:text-fg hover:underline"}`}
          >
            All files
          </button>
          {breadcrumb.map((folder) => (
            <span key={folder.id} className="flex items-center gap-1">
              <span className="text-fg-subtle">/</span>
              <button
                type="button"
                onClick={() => setCurrentFolderId(folder.id)}
                className={`focus-ring rounded-md px-1 ${folder.id === currentFolderId ? "font-medium text-fg" : "text-fg-muted hover:text-fg hover:underline"}`}
              >
                {folder.name}
              </button>
            </span>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Input
            type="search"
            placeholder="Search files…"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-40 sm:w-56"
          />
          <Button variant="secondary" size="sm" onClick={() => setNewFolderOpen((v) => !v)}>
            + New Folder
          </Button>
          <label>
            <span className={`focus-ring transition-standard inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-md bg-accent px-3 text-xs font-medium text-accent-fg hover:bg-accent-hover ${isUploading ? "pointer-events-none opacity-60" : ""}`}>
              {isUploading ? "Uploading…" : "Upload Files"}
            </span>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              disabled={isUploading}
              onChange={(e) => e.target.files && uploadFiles(e.target.files)}
              className="hidden"
            />
          </label>
        </div>
      </div>

      {newFolderOpen && (
        <div className="mt-3 flex items-center gap-2">
          <Input
            autoFocus
            type="text"
            placeholder="Folder name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateFolder()}
            className="w-56"
          />
          <Button size="sm" variant="primary" onClick={handleCreateFolder}>
            Create
          </Button>
        </div>
      )}

      {error && (
        <div className="mt-3">
          <InlineError message={error} />
        </div>
      )}

      {uploadRows.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-md border border-border p-3 text-sm">
          {uploadRows.map((row) => (
            <li key={row.key} className="flex items-center justify-between gap-2">
              <span className="truncate">{row.filename}</span>
              {row.status === "uploading" && <span className="text-fg-muted">Uploading…</span>}
              {row.status === "created" && <Badge tone="success">Uploaded</Badge>}
              {row.status === "duplicate" && <Badge tone="warning">Already uploaded</Badge>}
              {row.status === "failed" && <Badge tone="danger">{row.error ?? "Failed"}</Badge>}
            </li>
          ))}
        </ul>
      )}

      {searchResults !== null ? (
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium tracking-wide text-fg-muted uppercase">
            {searchResults.length} result{searchResults.length === 1 ? "" : "s"}
          </p>
          <DocumentList
            documents={searchResults}
            folderLabels={searchResults.map((r) => r.folderName ?? "All files")}
            selected={selected}
            onToggleSelected={toggleSelected}
            onRetry={handleRetry}
            onDelete={async (id) => {
              if (!confirm("Delete this document? This cannot be undone.")) return;
              await fetch(`/api/documents/${id}`, { method: "DELETE" });
              await refresh();
            }}
          />
        </div>
      ) : (
        <div
          className={`transition-standard mt-4 rounded-lg border-2 border-dashed p-4 ${isDragOver ? "border-accent bg-surface-muted" : "border-transparent"}`}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragOver(false);
            if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
          }}
        >
          {childFolders.length === 0 && folderDocuments.length === 0 ? (
            <EmptyState icon="📂" title="No folders or files here yet" description="Drag PDFs here or use Upload Files to get started." />
          ) : (
            <>
              {childFolders.length > 0 && (
                <ul className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {childFolders.map((folder) => (
                    <li key={folder.id} className="group flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                      <button type="button" onClick={() => setCurrentFolderId(folder.id)} className="focus-ring min-w-0 flex-1 truncate rounded text-left font-medium text-fg">
                        📁 {folder.name}
                      </button>
                      <div className="hidden shrink-0 gap-1 group-hover:flex">
                        <IconButton
                          label="Rename folder"
                          size="sm"
                          icon={<span aria-hidden="true">✎</span>}
                          onClick={() => {
                            const name = prompt("Rename folder", folder.name);
                            if (name) handleRenameFolder(folder.id, name);
                          }}
                        />
                        <IconButton
                          label="Delete folder"
                          size="sm"
                          className="hover:text-danger"
                          icon={<span aria-hidden="true">🗑</span>}
                          onClick={() => handleDeleteFolder(folder.id)}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <DocumentList
                documents={folderDocuments}
                selected={selected}
                onToggleSelected={toggleSelected}
                onRetry={handleRetry}
                onDelete={async (id) => {
                  if (!confirm("Delete this document? This cannot be undone.")) return;
                  await fetch(`/api/documents/${id}`, { method: "DELETE" });
                  await refresh();
                }}
              />
            </>
          )}
        </div>
      )}

      {selected.size > 0 && (
        <div className="animate-slide-up mt-3 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface-muted px-3 py-2 text-sm">
          <span className="font-medium text-fg">{selected.size} selected</span>
          <button type="button" onClick={() => bulkMove(currentFolderId)} className="focus-ring rounded text-fg-muted hover:text-fg hover:underline">
            Move here
          </button>
          <button type="button" onClick={() => bulkMove(null)} className="focus-ring rounded text-fg-muted hover:text-fg hover:underline">
            Move to root
          </button>
          <button type="button" onClick={bulkRetry} className="focus-ring rounded text-fg-muted hover:text-fg hover:underline">
            Retry ingestion
          </button>
          <button type="button" onClick={bulkDelete} className="focus-ring rounded text-danger hover:underline">
            Delete
          </button>
          <button type="button" onClick={() => setSelected(new Set())} className="focus-ring ml-auto rounded text-fg-subtle hover:underline">
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

function DocumentList({
  documents,
  folderLabels,
  selected,
  onToggleSelected,
  onRetry,
  onDelete,
}: {
  documents: DocumentData[];
  folderLabels?: string[];
  selected: Set<string>;
  onToggleSelected: (id: string) => void;
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (documents.length === 0) return null;

  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {documents.map((document, i) => {
        const status = statusLabel(document.processingStatus);
        return (
          <li key={document.id} className="flex items-center gap-3 px-4 py-3">
            <input
              type="checkbox"
              checked={selected.has(document.id)}
              onChange={() => onToggleSelected(document.id)}
              aria-label={`Select ${document.originalFilename}`}
              className="focus-ring accent-accent"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-fg">{document.originalFilename}</p>
              <p className="truncate text-xs text-fg-subtle">
                {folderLabels?.[i] ? `${folderLabels[i]} · ` : ""}
                {document._count.chunks} chunk{document._count.chunks === 1 ? "" : "s"}
                {document.processingError ? ` — ${document.processingError}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <Badge tone={statusTone(document.processingStatus)}>{status.label}</Badge>
              {document.processingStatus === "FAILED" && (
                <button type="button" onClick={() => onRetry(document.id)} className="focus-ring rounded text-sm font-medium text-fg hover:underline">
                  Retry
                </button>
              )}
              <button type="button" onClick={() => onDelete(document.id)} className="focus-ring rounded text-sm font-medium text-danger hover:underline">
                Delete
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
