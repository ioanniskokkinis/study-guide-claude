"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_DURATION_MINUTES, DEFAULT_PASSING_SCORE, DEFAULT_QUESTION_COUNT } from "@/lib/exam/config";

type ModeValue = "WRITTEN" | "ORAL" | "SCENARIO" | "ADAPTIVE";

async function parseJson(response: Response) {
  return response.json().catch(() => ({}));
}

/** Exam setup (spec §51). */
export function ExamSetupForm({ courseId }: { courseId: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<ModeValue>("WRITTEN");
  const [questionCount, setQuestionCount] = useState(DEFAULT_QUESTION_COUNT);
  const [durationMinutes, setDurationMinutes] = useState(DEFAULT_DURATION_MINUTES);
  const [difficulty, setDifficulty] = useState<string>("ADAPTIVE");
  const [allowHints, setAllowHints] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "ORAL") {
        router.push(`/courses/${courseId}/exam/oral`);
        return;
      }

      const response = await fetch(`/api/courses/${courseId}/exams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          questionCount,
          durationMinutes,
          difficulty: difficulty === "ADAPTIVE" ? "ADAPTIVE" : Number(difficulty),
          allowHints,
          allowSources: false,
          passingScore: DEFAULT_PASSING_SCORE,
        }),
      });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not create the exam.");
      router.push(`/courses/${courseId}/exam/${body.exam.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the exam.");
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Create Exam</h2>

      <div className="mt-4 space-y-4">
        <label className="block text-sm">
          <span className="text-zinc-500">Mode</span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as ModeValue)}
            className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="WRITTEN">Written</option>
            <option value="SCENARIO">Scenario</option>
            <option value="ADAPTIVE">Adaptive</option>
            <option value="ORAL">Oral</option>
          </select>
        </label>

        {mode !== "ORAL" && (
          <>
            <label className="block text-sm">
              <span className="text-zinc-500">Questions</span>
              <input
                type="number"
                min={5}
                max={50}
                value={questionCount}
                onChange={(e) => setQuestionCount(Number(e.target.value))}
                className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>

            <label className="block text-sm">
              <span className="text-zinc-500">Duration (minutes)</span>
              <input
                type="number"
                min={5}
                max={180}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Number(e.target.value))}
                className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>

            <label className="block text-sm">
              <span className="text-zinc-500">Difficulty</span>
              <select
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value)}
                className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="ADAPTIVE">Adaptive</option>
                <option value="1">1 (Easiest)</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="5">5 (Hardest)</option>
              </select>
            </label>

            <label className="flex items-center gap-2 text-sm text-zinc-500">
              <input type="checkbox" checked={allowHints} onChange={(e) => setAllowHints(e.target.checked)} />
              Allow hints (reduces mastery credit for hinted answers)
            </label>
          </>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <button
        type="button"
        onClick={() => void start()}
        disabled={busy}
        className="mt-5 rounded-md bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {busy ? "Starting…" : "Start Exam"}
      </button>
    </div>
  );
}
