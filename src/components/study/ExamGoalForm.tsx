"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { InlineError } from "@/components/ui/ErrorState";

interface GoalDTO {
  id: string;
  type: string;
  targetDate: string | null;
}

type LoadState = { status: "loading" } | { status: "ready"; goal: GoalDTO | null } | { status: "error" };

async function parseJson(response: Response) {
  return response.json().catch(() => ({}));
}

/** Basic exam-date goal setter (spec §15-16) — not a calendar planner, just enough for the adaptive engine's goal-relevance scoring to have a date to work with. */
export function ExamGoalForm({ courseId }: { courseId: string }) {
  const router = useRouter();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [date, setDate] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  async function loadGoals() {
    const next = await fetch(`/api/courses/${courseId}/goals`)
      .then(async (response) => {
        const body = await parseJson(response);
        if (!response.ok) throw new Error();
        const goals = (body.goals as GoalDTO[]) ?? [];
        return { status: "ready", goal: goals.find((g) => g.type === "EXAM") ?? null } as const;
      })
      .catch(() => ({ status: "error" }) as const);
    setLoad(next);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadGoals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  async function setExamDate(e: React.FormEvent) {
    e.preventDefault();
    if (!date) return;
    setActionError(null);
    setIsBusy(true);
    try {
      const response = await fetch(`/api/courses/${courseId}/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "EXAM", targetDate: new Date(date).toISOString() }),
      });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not set the exam date.");
      router.refresh();
      await loadGoals();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not set the exam date.");
    } finally {
      setIsBusy(false);
    }
  }

  async function clearGoal(goalId: string) {
    setActionError(null);
    setIsBusy(true);
    try {
      const response = await fetch(`/api/goals/${goalId}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await parseJson(response);
        throw new Error(body.error ?? "Could not clear the exam date.");
      }
      router.refresh();
      await loadGoals();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not clear the exam date.");
    } finally {
      setIsBusy(false);
    }
  }

  if (load.status !== "ready") return null;

  if (load.goal?.targetDate) {
    const daysUntil = Math.ceil((new Date(load.goal.targetDate).getTime() - now) / (1000 * 60 * 60 * 24));
    return (
      <div className="mt-4">
        <p className="text-xs text-fg-muted">
          Exam in {daysUntil >= 0 ? `${daysUntil} day${daysUntil === 1 ? "" : "s"}` : "the past"} (
          {new Date(load.goal.targetDate).toLocaleDateString()}) —{" "}
          <button type="button" onClick={() => clearGoal(load.goal!.id)} disabled={isBusy} className="focus-ring rounded underline underline-offset-2">
            clear
          </button>
        </p>
        {actionError && (
          <div className="mt-1">
            <InlineError message={actionError} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4">
      <form onSubmit={setExamDate} className="flex items-center gap-2 text-xs text-fg-muted">
        <span>Studying for an exam?</span>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-auto py-1 text-xs" />
        <Button type="submit" variant="secondary" size="sm" disabled={isBusy || !date}>
          Set date
        </Button>
      </form>
      {actionError && (
        <div className="mt-1">
          <InlineError message={actionError} />
        </div>
      )}
    </div>
  );
}
