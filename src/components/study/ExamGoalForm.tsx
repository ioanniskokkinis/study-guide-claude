"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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
    setIsBusy(true);
    try {
      await fetch(`/api/courses/${courseId}/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "EXAM", targetDate: new Date(date).toISOString() }),
      });
      router.refresh();
      await loadGoals();
    } finally {
      setIsBusy(false);
    }
  }

  async function clearGoal(goalId: string) {
    setIsBusy(true);
    try {
      await fetch(`/api/goals/${goalId}`, { method: "DELETE" });
      router.refresh();
      await loadGoals();
    } finally {
      setIsBusy(false);
    }
  }

  if (load.status !== "ready") return null;

  if (load.goal?.targetDate) {
    const daysUntil = Math.ceil((new Date(load.goal.targetDate).getTime() - now) / (1000 * 60 * 60 * 24));
    return (
      <p className="mt-4 text-xs text-zinc-500">
        Exam in {daysUntil >= 0 ? `${daysUntil} day${daysUntil === 1 ? "" : "s"}` : "the past"} (
        {new Date(load.goal.targetDate).toLocaleDateString()}) —{" "}
        <button type="button" onClick={() => clearGoal(load.goal!.id)} disabled={isBusy} className="underline underline-offset-2">
          clear
        </button>
      </p>
    );
  }

  return (
    <form onSubmit={setExamDate} className="mt-4 flex items-center gap-2 text-xs text-zinc-500">
      <span>Studying for an exam?</span>
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-transparent"
      />
      <button
        type="submit"
        disabled={isBusy || !date}
        className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        Set date
      </button>
    </form>
  );
}
