"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { InlineError } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/Skeleton";

interface Reason {
  type: string;
  message: string;
}

interface NextLearningActionDTO {
  actionType: "ACTIVE_RECALL" | "REMEDIATION" | "PREREQUISITE_REVIEW" | "REVIEW" | "CHALLENGE" | "REST";
  conceptId: string;
  conceptName: string;
  priority: number;
  difficulty: number;
  suggestedQuestionType: string;
  reason: Reason;
  factors: string[];
  estimatedDurationMinutes: number;
}

const ACTION_HEADLINE: Record<NextLearningActionDTO["actionType"], (name: string) => string> = {
  ACTIVE_RECALL: (name) => `Practice ${name}`,
  REMEDIATION: (name) => `Strengthen ${name}`,
  PREREQUISITE_REVIEW: (name) => `Review ${name}`,
  REVIEW: (name) => `Review ${name}`,
  CHALLENGE: (name) => `Challenge yourself: ${name}`,
  REST: () => "Take a break",
};

interface ConceptOption {
  id: string;
  name: string;
  mastery: number;
  exposureCount: number;
}

async function parseJson(response: Response) {
  return response.json().catch(() => ({}));
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; action: NextLearningActionDTO; decisionLogId: string }
  | { status: "error"; message: string };

export function AdaptiveDashboard({ courseId, concepts }: { courseId: string; concepts: ConceptOption[] }) {
  const router = useRouter();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [showWhy, setShowWhy] = useState(false);
  const [showOverride, setShowOverride] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  async function loadAction() {
    const next = await fetch(`/api/courses/${courseId}/next-action`)
      .then(async (response) => {
        const body = await parseJson(response);
        if (!response.ok) throw new Error(body.error ?? "Could not compute a recommendation.");
        return { status: "ready", action: body.action as NextLearningActionDTO, decisionLogId: body.decisionLogId as string } as const;
      })
      .catch(
        (err) => ({ status: "error", message: err instanceof Error ? err.message : "Could not compute a recommendation." }) as const,
      );
    setLoad(next);
  }

  useEffect(() => {
    // One-time data fetch on mount/course-change, not a subscription to an
    // external system — the rule's "cascading renders" concern doesn't
    // apply here (single terminal setState, no render-triggered refetch loop).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAction();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  const decisionLogId = load.status === "ready" ? load.decisionLogId : null;
  const action = load.status === "ready" ? load.action : null;

  async function respond(accepted: boolean) {
    if (!decisionLogId) return;
    await fetch(`/api/next-action/${decisionLogId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accepted }),
    }).catch(() => undefined);
  }

  async function start() {
    setIsBusy(true);
    try {
      await respond(true);
      const response = await fetch(`/api/courses/${courseId}/study/recall/session`, { method: "POST" });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not start a session.");
      router.push(`/courses/${courseId}/study/recall`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not start a session.");
      setIsBusy(false);
    }
  }

  async function startWithConcept(conceptId: string) {
    setIsBusy(true);
    try {
      await respond(false);
      const response = await fetch(`/api/courses/${courseId}/study/recall/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conceptId }),
      });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not start a session.");
      router.push(`/courses/${courseId}/study/recall`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not start a session.");
      setIsBusy(false);
    }
  }

  if (load.status === "loading") {
    return <LoadingState label="Thinking about what to study next" />;
  }

  if (load.status === "error") {
    return <InlineError message={load.message} />;
  }

  if (!action) return null;

  return (
    <Card>
      <h2 className="text-xs font-medium tracking-wide text-fg-muted uppercase">Next Best Action</h2>
      <p className="mt-2 text-xl font-semibold text-fg">{ACTION_HEADLINE[action.actionType](action.conceptName)}</p>

      <button type="button" onClick={() => setShowWhy((v) => !v)} className="focus-ring mt-3 rounded text-sm text-fg-muted hover:underline">
        {showWhy ? "Hide why" : "Why?"}
      </button>
      {showWhy && (
        <div className="mt-2 rounded-md bg-surface-muted p-3 text-sm text-fg-muted">
          <p>{action.reason.message}</p>
          {action.factors.length > 0 && (
            <ul className="mt-2 list-inside list-disc space-y-0.5">
              {action.factors.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="mt-3 text-sm text-fg-muted">Estimated time: {action.estimatedDurationMinutes} min</p>

      {actionError && (
        <div className="mt-3">
          <InlineError message={actionError} />
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <Button variant="primary" loading={isBusy} onClick={start}>
          {isBusy ? "Starting…" : "Start"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setShowOverride((v) => !v)} disabled={isBusy}>
          Study something else
        </Button>
      </div>

      {showOverride && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="text-sm text-fg-muted">Pick a concept to study instead:</p>
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
            {concepts.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => startWithConcept(c.id)}
                  disabled={isBusy}
                  className="focus-ring transition-standard flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-hover disabled:opacity-50"
                >
                  <span className="text-fg">{c.name}</span>
                  <span className="text-xs text-fg-subtle">{c.exposureCount > 0 ? `${Math.round(c.mastery * 100)}%` : "unassessed"}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
