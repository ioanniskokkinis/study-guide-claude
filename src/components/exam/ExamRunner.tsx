"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

interface Option {
  id: string;
  text: string;
}

interface Scenario {
  context: string;
  objective: string;
  constraints: string[];
  availableInformation: string[];
}

interface ExamQuestionDTO {
  id: string;
  position: number;
  questionType: "MULTIPLE_CHOICE" | "MULTI_SELECT" | "TRUE_FALSE" | "SHORT_ANSWER" | "OPEN_ENDED" | "PROBLEM_SOLVING" | "SCENARIO" | "TEACH_BACK";
  prompt: string;
  options: Option[] | null;
  scenario: Scenario | null;
  points: number;
  answered: boolean;
}

interface ExamDTO {
  id: string;
  mode: "WRITTEN" | "ORAL" | "SCENARIO" | "ADAPTIVE";
  status: "CREATED" | "ACTIVE" | "PAUSED" | "SUBMITTED" | "GRADED" | "EXPIRED" | "ABANDONED";
  questionCount: number;
  timeLimitSeconds: number | null;
  currentQuestionIndex: number;
}

interface ExamStateDTO {
  exam: ExamDTO;
  remainingSeconds: number | null;
  questions: ExamQuestionDTO[];
}

type LoadState = { status: "loading" } | { status: "ready"; data: ExamStateDTO } | { status: "error"; message: string };

interface DraftAnswer {
  answerText: string;
  selectedOptionIds: string[];
  confidence: "CONFIDENT" | "UNSURE" | "GUESSING" | null;
}

async function parseJson(response: Response) {
  return response.json().catch(() => ({}));
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function emptyDraft(): DraftAnswer {
  return { answerText: "", selectedOptionIds: [], confidence: null };
}

export function ExamRunner({ courseId, examId }: { courseId: string; examId: string }) {
  const router = useRouter();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>({});
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tickSeconds, setTickSeconds] = useState<number | null>(null);

  async function loadState() {
    const next = await fetch(`/api/exams/${examId}`)
      .then(async (response) => {
        const body = await parseJson(response);
        if (!response.ok) throw new Error(body.error ?? "Could not load the exam.");
        return { status: "ready", data: body as ExamStateDTO } as const;
      })
      .catch((err) => ({ status: "error", message: err instanceof Error ? err.message : "Could not load the exam." }) as const);
    setLoad(next);
    if (next.status === "ready") {
      setTickSeconds(next.data.remainingSeconds);
      if (next.data.exam.status === "GRADED" || next.data.exam.status === "SUBMITTED") {
        router.replace(`/courses/${courseId}/exam/${examId}/result`);
      }
    }
  }

  useEffect(() => {
    // One-time fetch on mount/exam-change — not a subscription to an external system.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId]);

  useEffect(() => {
    if (tickSeconds == null || load.status !== "ready" || load.data.exam.status !== "ACTIVE") return;
    const id = setInterval(() => {
      setTickSeconds((s) => (s == null ? s : Math.max(0, s - 1)));
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickSeconds != null, load.status]);

  const questions = useMemo(() => (load.status === "ready" ? load.data.questions : []), [load]);
  const current = questions[index] ?? null;
  const draft = current ? (drafts[current.id] ?? emptyDraft()) : emptyDraft();

  const unansweredCount = useMemo(() => questions.filter((q) => !q.answered).length, [questions]);

  function updateDraft(questionId: string, patch: Partial<DraftAnswer>) {
    setDrafts((prev) => ({ ...prev, [questionId]: { ...(prev[questionId] ?? emptyDraft()), ...patch } }));
  }

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch(`/api/exams/${examId}/start`, { method: "POST" });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not start the exam.");
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the exam.");
    } finally {
      setStarting(false);
    }
  }

  async function saveAndAdvance() {
    if (!current || load.status !== "ready") return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/exams/${examId}/answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionId: current.id,
          answerText: draft.answerText,
          selectedOptionIds: draft.selectedOptionIds,
          confidence: draft.confidence,
        }),
      });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not save this answer.");

      const updatedQuestions = questions.map((q) => (q.id === current.id ? { ...q, answered: true } : q));
      const nextQuestion = body.nextQuestion as ExamQuestionDTO | null | undefined;
      const merged = nextQuestion && !updatedQuestions.some((q) => q.id === nextQuestion.id) ? [...updatedQuestions, { ...nextQuestion, answered: false }] : updatedQuestions;

      setLoad({ status: "ready", data: { ...load.data, questions: merged } });

      if (index < merged.length - 1) {
        setIndex(index + 1);
      } else if (body.examComplete) {
        setConfirmSubmit(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this answer.");
    } finally {
      setSaving(false);
    }
  }

  async function finalSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/exams/${examId}/submit`, { method: "POST" });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not submit the exam.");
      router.push(`/courses/${courseId}/exam/${examId}/result`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit the exam.");
      setSubmitting(false);
    }
  }

  if (load.status === "loading") {
    return <p className="text-sm text-zinc-500">Loading exam…</p>;
  }
  if (load.status === "error") {
    return <p className="text-sm text-red-600 dark:text-red-400">{load.message}</p>;
  }

  const { exam } = load.data;

  if (exam.status === "CREATED") {
    return (
      <div className="rounded-lg border border-zinc-200 p-6 text-center dark:border-zinc-800">
        <p className="text-sm text-zinc-500">{exam.questionCount} questions{exam.timeLimitSeconds ? ` · ${Math.round(exam.timeLimitSeconds / 60)} min` : ""}</p>
        <button
          type="button"
          onClick={() => void start()}
          disabled={starting}
          className="mt-4 rounded-md bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {starting ? "Starting…" : "Begin Exam"}
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between border-b border-zinc-200 pb-3 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-500">
          Question {index + 1} / {questions.length}
        </p>
        {tickSeconds != null && (
          <p className={tickSeconds < 60 ? "text-sm font-mono text-red-600 dark:text-red-400" : "text-sm font-mono text-zinc-500"}>{formatTime(tickSeconds)}</p>
        )}
      </div>

      {current && (
        <div className="mt-6">
          {current.scenario && (
            <div className="mb-4 rounded-md bg-zinc-50 p-4 text-sm dark:bg-zinc-900">
              <p className="font-medium text-zinc-700 dark:text-zinc-300">{current.scenario.context}</p>
              <p className="mt-2 text-zinc-600 dark:text-zinc-400">Objective: {current.scenario.objective}</p>
              {current.scenario.constraints.length > 0 && (
                <ul className="mt-2 list-inside list-disc text-zinc-600 dark:text-zinc-400">
                  {current.scenario.constraints.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <p className="text-base text-zinc-900 dark:text-zinc-50">{current.prompt}</p>

          <div className="mt-4">
            {current.options ? (
              <div className="space-y-2">
                {current.options.map((opt) => {
                  const multi = current.questionType === "MULTI_SELECT";
                  const checked = draft.selectedOptionIds.includes(opt.id);
                  return (
                    <label key={opt.id} className="flex items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
                      <input
                        type={multi ? "checkbox" : "radio"}
                        name={current.id}
                        checked={checked}
                        onChange={() =>
                          updateDraft(current.id, {
                            selectedOptionIds: multi
                              ? checked
                                ? draft.selectedOptionIds.filter((id) => id !== opt.id)
                                : [...draft.selectedOptionIds, opt.id]
                              : [opt.id],
                          })
                        }
                      />
                      {opt.text}
                    </label>
                  );
                })}
              </div>
            ) : (
              <textarea
                value={draft.answerText}
                onChange={(e) => updateDraft(current.id, { answerText: e.target.value })}
                rows={6}
                placeholder="Your answer…"
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
              />
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-400">Confidence:</span>
            {(["GUESSING", "UNSURE", "CONFIDENT"] as const).map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => updateDraft(current.id, { confidence: draft.confidence === level ? null : level })}
                className={
                  draft.confidence === level
                    ? "rounded-full bg-zinc-900 px-2.5 py-1 text-xs text-white dark:bg-zinc-50 dark:text-zinc-900"
                    : "rounded-full border border-zinc-300 px-2.5 py-1 text-xs text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                }
              >
                {level === "CONFIDENT" ? "Confident" : level === "UNSURE" ? "Unsure" : "Guessing"}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          disabled={index === 0}
          className="text-sm text-zinc-500 underline-offset-2 hover:underline disabled:opacity-30"
        >
          Previous
        </button>
        <button
          type="button"
          onClick={() => void saveAndAdvance()}
          disabled={saving}
          className="rounded-md bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {saving ? "Saving…" : "Save & Next"}
        </button>
      </div>

      <div className="mt-6 border-t border-zinc-200 pt-4 text-center dark:border-zinc-800">
        {confirmSubmit || unansweredCount === 0 ? (
          <div>
            {unansweredCount > 0 && <p className="mb-2 text-sm text-amber-700 dark:text-amber-400">{unansweredCount} question{unansweredCount === 1 ? "" : "s"} unanswered.</p>}
            <button
              type="button"
              onClick={() => void finalSubmit()}
              disabled={submitting}
              className="rounded-md bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {submitting ? "Submitting…" : "Submit Exam"}
            </button>
            {confirmSubmit && (
              <button type="button" onClick={() => setConfirmSubmit(false)} className="ml-3 text-sm text-zinc-500 underline-offset-2 hover:underline">
                Return to questions
              </button>
            )}
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmSubmit(true)} className="text-sm text-zinc-500 underline-offset-2 hover:underline">
            Finish and submit
          </button>
        )}
      </div>
    </div>
  );
}
