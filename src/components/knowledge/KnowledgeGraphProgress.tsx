"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface KnowledgeGraphProgressProps {
  courseId: string;
  initialStatus: string;
  initialProgress: number;
  initialStageMessage: string | null;
  initialError: string | null;
  conceptCount: number;
  relationshipCount: number;
  prerequisiteCount: number;
}

interface ProgressResponse {
  status: string;
  progress: number;
  stage: string | null;
  message: string | null;
  error: string | null;
}

const CHECKLIST = [
  { label: "Concepts", threshold: 50 },
  { label: "Relationships", threshold: 75 },
  { label: "Prerequisites", threshold: 90 },
  { label: "Validation", threshold: 95 },
  { label: "Saving", threshold: 100 },
];

const POLL_INTERVAL_MS = 1500;
const RUNNING_STATUSES = new Set(["QUEUED", "PROCESSING"]);

function checklistIcon(progress: number, status: string, threshold: number, prevThreshold: number) {
  if (status === "FAILED" && progress < threshold) return "○";
  if (progress >= threshold) return "✓";
  if (progress >= prevThreshold) return "⟳";
  return "○";
}

/**
 * The Knowledge Base control panel (production-hardening phase §B) — real
 * progress polled from the server, never a fake timer. Never blocks the
 * rest of the course/knowledge page: this component owns only its own
 * loading/error state and never throws past its own boundary.
 */
export function KnowledgeGraphProgress({
  courseId,
  initialStatus,
  initialProgress,
  initialStageMessage,
  initialError,
  conceptCount,
  relationshipCount,
  prerequisiteCount,
}: KnowledgeGraphProgressProps) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [progress, setProgress] = useState(initialProgress);
  const [message, setMessage] = useState(initialStageMessage);
  const [error, setError] = useState(initialError);
  const [starting, setStarting] = useState(false);
  const wasRunning = useRef(false);

  useEffect(() => {
    if (!RUNNING_STATUSES.has(status)) return;
    wasRunning.current = true;

    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/courses/${courseId}/knowledge/progress`);
        if (!response.ok || cancelled) return;
        const data: ProgressResponse = await response.json();
        if (cancelled) return;
        setStatus(data.status);
        setProgress(data.progress);
        setMessage(data.message);
        setError(data.error);
        if (!RUNNING_STATUSES.has(data.status) && wasRunning.current) {
          router.refresh();
        }
      } catch {
        // A transient polling failure just tries again next tick — never surfaces as a page error.
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status, courseId, router]);

  async function handleStart() {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch(`/api/courses/${courseId}/knowledge/build`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not start the knowledge graph build.");
      setStatus("QUEUED");
      setProgress(0);
      setMessage("Queued…");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the knowledge graph build.");
    } finally {
      setStarting(false);
    }
  }

  const isRunning = RUNNING_STATUSES.has(status);

  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-50">Knowledge Base</h2>
        {!isRunning && (
          <button
            type="button"
            onClick={handleStart}
            disabled={starting}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-70 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {starting ? "Starting…" : status === "NOT_STARTED" ? "Build Knowledge Graph" : "Rebuild"}
          </button>
        )}
      </div>

      {isRunning && (
        <div className="mt-3">
          <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
            <div className="h-full bg-zinc-900 transition-all dark:bg-zinc-50" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {progress}% — {message ?? "Working…"}
          </p>
          <ul className="mt-3 space-y-1 text-xs text-zinc-500">
            {CHECKLIST.map((item, i) => (
              <li key={item.label}>
                {checklistIcon(progress, status, item.threshold, CHECKLIST[i - 1]?.threshold ?? 0)} {item.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      {status === "FAILED" && (
        <div className="mt-3">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {conceptCount > 0 ? "⚠ Knowledge Base partially built" : "⚠ Knowledge Base could not be built"}
          </p>
          {error && <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{error}</p>}
        </div>
      )}

      {status === "READY" && error && (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">⚠ Knowledge Base partially built — {error}</p>
      )}

      {(status === "READY" || status === "FAILED") && (
        <dl className="mt-4 grid grid-cols-3 gap-4 text-center">
          <div>
            <dt className="text-xs text-zinc-400">Concepts</dt>
            <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{conceptCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-400">Relationships</dt>
            <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{relationshipCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-400">Prerequisites</dt>
            <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{prerequisiteCount}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}
