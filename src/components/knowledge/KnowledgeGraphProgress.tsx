"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { InlineError } from "@/components/ui/ErrorState";
import { knowledgeStatusLabel, knowledgeStatusTone } from "./status-label";

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
  const statusInfo = knowledgeStatusLabel(status);

  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-fg">Knowledge Base</h2>
          {!isRunning && <Badge tone={knowledgeStatusTone(status)}>{statusInfo.label}</Badge>}
        </div>
        {!isRunning && (
          <Button variant="primary" size="sm" loading={starting} onClick={handleStart}>
            {starting ? "Starting…" : status === "NOT_STARTED" ? "Build Knowledge Graph" : "Rebuild"}
          </Button>
        )}
      </div>

      {isRunning && (
        <div className="mt-4">
          <ProgressBar value={progress / 100} label="Knowledge graph build progress" />
          <p className="mt-1.5 text-xs text-fg-muted">
            {progress}% — {message ?? "Working…"}
          </p>
          <ul className="mt-3 space-y-1 text-xs text-fg-muted">
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
          <p className="text-sm font-medium text-warning">
            {conceptCount > 0 ? "⚠ Knowledge Base partially built" : "⚠ Knowledge Base could not be built"}
          </p>
          {error && (
            <div className="mt-1">
              <InlineError message={error} />
            </div>
          )}
        </div>
      )}

      {status === "READY" && error && <p className="mt-3 text-sm text-warning">⚠ Knowledge Base partially built — {error}</p>}

      {(status === "READY" || status === "FAILED") && (
        <dl className="mt-4 grid grid-cols-3 gap-4 text-center">
          <div>
            <dt className="text-xs text-fg-subtle">Concepts</dt>
            <dd className="text-lg font-semibold text-fg">{conceptCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-subtle">Relationships</dt>
            <dd className="text-lg font-semibold text-fg">{relationshipCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-subtle">Prerequisites</dt>
            <dd className="text-lg font-semibold text-fg">{prerequisiteCount}</dd>
          </div>
        </dl>
      )}
    </Card>
  );
}
