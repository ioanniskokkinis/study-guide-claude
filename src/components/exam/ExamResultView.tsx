"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface ConceptScore {
  name: string;
  score: number;
  questionCount: number;
}

interface ReadinessDTO {
  readiness: number;
  status: "NOT_READY" | "DEVELOPING" | "ALMOST_READY" | "READY" | "MASTERED";
  weakAreas: string[];
  recommendation: string;
  explanation: string;
}

interface NextActionDTO {
  action: string;
  conceptId: string | null;
  conceptName: string | null;
  reason: string;
}

interface QuestionReviewDTO {
  questionId: string;
  prompt: string;
  conceptName: string;
  classification: string | null;
  score: number | null;
  feedback: string | null;
  missingConcepts: string[];
  expectedAnswer: string | null;
}

export interface ExamResultDTO {
  examId: string;
  percentage: number;
  passed: boolean;
  totalQuestions: number;
  correctAnswers: number;
  partialAnswers: number;
  incorrectAnswers: number;
  unanswered: number;
  timeSpentSeconds: number;
  conceptScores: Record<string, ConceptScore>;
  cognitiveScores: Record<string, number>;
  mistakeSummary: { totalMistakes: number; byCategory: Partial<Record<string, number>>; prerequisiteFailures: number };
  readiness: ReadinessDTO;
  nextAction: NextActionDTO;
  weakConcepts: string[];
  questions: QuestionReviewDTO[];
}

async function parseJson(response: Response) {
  return response.json().catch(() => ({}));
}

function formatMinutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

const CLASSIFICATION_LABEL: Record<string, string> = {
  CORRECT: "Correct",
  PARTIALLY_CORRECT: "Partially correct",
  INCORRECT: "Incorrect",
  MISCONCEPTION: "Misconception",
  UNANSWERED: "Unanswered",
};

/** Post-exam analysis (spec §37-39, §43, §63) — full feedback, only shown after submission. */
export function ExamResultView({ courseId, result }: { courseId: string; result: ExamResultDTO }) {
  const router = useRouter();
  const [retesting, setRetesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startRetest() {
    setRetesting(true);
    setError(null);
    try {
      const conceptIds = Object.entries(result.conceptScores)
        .filter(([, c]) => c.score < 0.6)
        .map(([id]) => id);
      const response = await fetch(`/api/courses/${courseId}/exams/retest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conceptIds: conceptIds.length > 0 ? conceptIds : Object.keys(result.conceptScores) }),
      });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not create the retest.");
      router.push(`/courses/${courseId}/exam/${body.exam.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the retest.");
      setRetesting(false);
    }
  }

  const incorrectQuestions = result.questions.filter((q) => q.classification && q.classification !== "CORRECT");

  return (
    <div className="mt-6">
      <div className="rounded-lg border border-zinc-200 p-6 text-center dark:border-zinc-800">
        <p className="text-4xl font-semibold text-zinc-900 dark:text-zinc-50">{Math.round(result.percentage * 100)}%</p>
        <p className={result.passed ? "mt-1 text-sm text-emerald-600 dark:text-emerald-400" : "mt-1 text-sm text-red-600 dark:text-red-400"}>
          {result.passed ? "Passed" : "Not passed"}
        </p>
        <p className="mt-3 text-sm text-zinc-500">
          {result.correctAnswers} correct · {result.partialAnswers} partial · {result.incorrectAnswers} incorrect · {result.unanswered} unanswered ·{" "}
          {formatMinutes(result.timeSpentSeconds)}
        </p>
      </div>

      <div className="mt-6 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
        <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Concept Scores</h2>
        <ul className="mt-3 space-y-2">
          {Object.entries(result.conceptScores)
            .sort((a, b) => a[1].score - b[1].score)
            .map(([id, c]) => (
              <li key={id} className="flex items-center gap-3 text-sm">
                <span className="w-32 shrink-0 truncate text-zinc-700 dark:text-zinc-300">{c.name}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
                  <div
                    className={c.score >= 0.75 ? "h-full bg-emerald-500" : c.score >= 0.5 ? "h-full bg-amber-500" : "h-full bg-red-500"}
                    style={{ width: `${Math.round(c.score * 100)}%` }}
                  />
                </div>
                <span className="w-10 shrink-0 text-right text-zinc-500">{Math.round(c.score * 100)}%</span>
              </li>
            ))}
        </ul>
      </div>

      <div className="mt-6 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
        <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Cognitive Scores</h2>
        <ul className="mt-3 space-y-2">
          {Object.entries(result.cognitiveScores)
            .filter(([, score]) => score > 0)
            .map(([level, score]) => (
              <li key={level} className="flex items-center justify-between text-sm">
                <span className="text-zinc-700 dark:text-zinc-300">{level}</span>
                <span className="text-zinc-500">{Math.round(score * 100)}%</span>
              </li>
            ))}
        </ul>
      </div>

      <div className="mt-6 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
        <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Recommended Next Step</h2>
        <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">{result.nextAction.reason}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void startRetest()}
            disabled={retesting}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {retesting ? "Preparing…" : "Retest Weak Areas"}
          </button>
          <a href={`/courses/${courseId}/tutor`} className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900">
            Study with the Tutor
          </a>
        </div>
        {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>

      {incorrectQuestions.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-medium text-zinc-500">Review</h2>
          <ul className="mt-2 space-y-3">
            {incorrectQuestions.map((q) => (
              <li key={q.questionId} className="rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
                <p className="text-xs font-medium text-zinc-400 uppercase">
                  {q.conceptName} · {q.classification ? CLASSIFICATION_LABEL[q.classification] : ""}
                </p>
                <p className="mt-1 text-zinc-700 dark:text-zinc-300">{q.prompt}</p>
                {q.feedback && <p className="mt-2 text-zinc-500">{q.feedback}</p>}
                {q.missingConcepts.length > 0 && <p className="mt-1 text-zinc-500">Missing: {q.missingConcepts.join(", ")}</p>}
                {q.expectedAnswer && (
                  <p className="mt-2 text-zinc-600 dark:text-zinc-400">
                    <span className="font-medium">Reference:</span> {q.expectedAnswer}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
