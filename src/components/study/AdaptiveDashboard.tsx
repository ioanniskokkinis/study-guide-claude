"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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
    return <p className="text-sm text-zinc-500">Thinking about what to study next…</p>;
  }

  if (load.status === "error") {
    return <p className="text-sm text-red-600 dark:text-red-400">{load.message}</p>;
  }

  if (!action) return null;

  return (
    <div className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Next Best Action</h2>
      <p className="mt-2 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        {ACTION_HEADLINE[action.actionType](action.conceptName)}
      </p>

      <button
        type="button"
        onClick={() => setShowWhy((v) => !v)}
        className="mt-3 text-sm text-zinc-500 underline-offset-2 hover:underline"
      >
        {showWhy ? "Hide why" : "Why?"}
      </button>
      {showWhy && (
        <div className="mt-2 rounded-md bg-zinc-50 p-3 text-sm text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
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

      <p className="mt-3 text-sm text-zinc-500">Estimated time: {action.estimatedDurationMinutes} min</p>

      {actionError && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{actionError}</p>}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={start}
          disabled={isBusy}
          className="rounded-md bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {isBusy ? "Starting…" : "Start"}
        </button>
        <button
          type="button"
          onClick={() => setShowOverride((v) => !v)}
          disabled={isBusy}
          className="text-sm text-zinc-500 underline-offset-2 hover:underline disabled:opacity-50"
        >
          Study something else
        </button>
      </div>

      {showOverride && (
        <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <p className="text-sm text-zinc-500">Pick a concept to study instead:</p>
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
            {concepts.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => startWithConcept(c.id)}
                  disabled={isBusy}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-900"
                >
                  <span>{c.name}</span>
                  <span className="text-xs text-zinc-400">
                    {c.exposureCount > 0 ? `${Math.round(c.mastery * 100)}%` : "unassessed"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
