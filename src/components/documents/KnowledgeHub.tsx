"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { statusLabel } from "@/components/documents/status-label";

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
        <div className="flex items-center gap-1 text-sm">
          <button
            type="button"
            onClick={() => setCurrentFolderId(null)}
            className={currentFolderId === null ? "font-medium text-zinc-900 dark:text-zinc-50" : "text-zinc-500 hover:underline"}
          >
            All files
          </button>
          {breadcrumb.map((folder) => (
            <span key={folder.id} className="flex items-center gap-1">
              <span className="text-zinc-400">/</span>
              <button
                type="button"
                onClick={() => setCurrentFolderId(folder.id)}
                className={folder.id === currentFolderId ? "font-medium text-zinc-900 dark:text-zinc-50" : "text-zinc-500 hover:underline"}
              >
                {folder.name}
              </button>
            </span>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <input
            type="search"
            placeholder="Search files…"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
          <button
            type="button"
            onClick={() => setNewFolderOpen((v) => !v)}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
          >
            + New Folder
          </button>
          <label
            className={`inline-flex cursor-pointer items-center rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 ${isUploading ? "pointer-events-none opacity-70" : ""}`}
          >
            {isUploading ? "Uploading…" : "Upload Files"}
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
          <input
            autoFocus
            type="text"
            placeholder="Folder name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateFolder()}
            className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
          <button type="button" onClick={handleCreateFolder} className="text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-50">
            Create
          </button>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {uploadRows.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
          {uploadRows.map((row) => (
            <li key={row.key} className="flex items-center justify-between gap-2">
              <span className="truncate">{row.filename}</span>
              <span
                className={
                  row.status === "created"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : row.status === "duplicate"
                      ? "text-amber-600 dark:text-amber-400"
                      : row.status === "failed"
                        ? "text-red-600 dark:text-red-400"
                        : "text-zinc-500"
                }
              >
                {row.status === "uploading" && "Uploading…"}
                {row.status === "created" && "✓ Uploaded"}
                {row.status === "duplicate" && "Already uploaded"}
                {row.status === "failed" && (row.error ?? "Failed")}
              </span>
            </li>
          ))}
        </ul>
      )}

      {searchResults !== null ? (
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium tracking-wide text-zinc-400 uppercase">
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
          className={`mt-4 rounded-lg border-2 border-dashed p-4 transition-colors ${isDragOver ? "border-zinc-900 bg-zinc-50 dark:border-zinc-50 dark:bg-zinc-900" : "border-transparent"}`}
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
            <p className="py-6 text-center text-sm text-zinc-500">
              No folders or files here yet. Drag PDFs here or use Upload Files.
            </p>
          ) : (
            <>
              {childFolders.length > 0 && (
                <ul className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {childFolders.map((folder) => (
                    <li key={folder.id} className="group flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
                      <button type="button" onClick={() => setCurrentFolderId(folder.id)} className="min-w-0 flex-1 truncate text-left font-medium">
                        📁 {folder.name}
                      </button>
                      <div className="hidden shrink-0 gap-2 group-hover:flex">
                        <button
                          type="button"
                          onClick={() => {
                            const name = prompt("Rename folder", folder.name);
                            if (name) handleRenameFolder(folder.id, name);
                          }}
                          className="text-xs text-zinc-400 hover:underline"
                        >
                          Rename
                        </button>
                        <button type="button" onClick={() => handleDeleteFolder(folder.id)} className="text-xs text-red-500 hover:underline">
                          Delete
                        </button>
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
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          <span className="font-medium">{selected.size} selected</span>
          <button type="button" onClick={() => bulkMove(currentFolderId)} className="hover:underline">
            Move here
          </button>
          <button type="button" onClick={() => bulkMove(null)} className="hover:underline">
            Move to root
          </button>
          <button type="button" onClick={bulkRetry} className="hover:underline">
            Retry ingestion
          </button>
          <button type="button" onClick={bulkDelete} className="text-red-600 hover:underline dark:text-red-400">
            Delete
          </button>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto text-zinc-400 hover:underline">
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
    <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
      {documents.map((document, i) => {
        const status = statusLabel(document.processingStatus);
        return (
          <li key={document.id} className="flex items-center gap-3 px-4 py-3">
            <input
              type="checkbox"
              checked={selected.has(document.id)}
              onChange={() => onToggleSelected(document.id)}
              aria-label={`Select ${document.originalFilename}`}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-zinc-900 dark:text-zinc-50">{document.originalFilename}</p>
              <p className="truncate text-xs text-zinc-400">
                {folderLabels?.[i] ? `${folderLabels[i]} · ` : ""}
                {document._count.chunks} chunk{document._count.chunks === 1 ? "" : "s"}
                {document.processingError ? ` — ${document.processingError}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className={`text-sm font-medium ${status.className}`}>{status.label}</span>
              {document.processingStatus === "FAILED" && (
                <button type="button" onClick={() => onRetry(document.id)} className="text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-50">
                  Retry
                </button>
              )}
              <button type="button" onClick={() => onDelete(document.id)} className="text-sm font-medium text-red-600 hover:underline dark:text-red-400">
                Delete
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
