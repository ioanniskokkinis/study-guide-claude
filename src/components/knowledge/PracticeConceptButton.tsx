"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const PRACTICE_QUESTION_COUNT = 5;

/**
 * "Practice" a single concept (production-hardening phase §C/§I) — creates
 * (or reuses a cached, unfinished — see exam-orchestrator.ts's
 * findReusableExam) a short WRITTEN exam scoped to just this concept via
 * the existing Exam engine. No second quiz system.
 */
export function PracticeConceptButton({
  courseId,
  conceptId,
  label = "Practice",
}: {
  courseId: string;
  conceptId: string;
  label?: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/courses/${courseId}/exams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "WRITTEN", questionCount: PRACTICE_QUESTION_COUNT, targetConceptIds: [conceptId] }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not start practice.");
      router.push(`/courses/${courseId}/exam/${body.exam.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start practice.");
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
      >
        {loading ? "Starting…" : label}
      </button>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
