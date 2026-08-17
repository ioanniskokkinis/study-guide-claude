"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { InlineError } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/Skeleton";
import { ProgressBar } from "@/components/ui/ProgressBar";

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

const CONFIDENCE_LABEL: Record<NonNullable<DraftAnswer["confidence"]>, string> = {
  CONFIDENT: "Confident",
  UNSURE: "Unsure",
  GUESSING: "Guessing",
};

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

  // Phase 19 §19.18 — a screen reader shouldn't hear the countdown every
  // second (that would drown out everything else). This is derived, not
  // effect-driven state: the live region's text stays identical on every
  // render while under a minute, so a screen reader announces it once when
  // it first appears and stays silent on every re-render after that.
  const lowTimeRemaining = tickSeconds != null && tickSeconds < 60;

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
    return <LoadingState label="Loading exam" />;
  }
  if (load.status === "error") {
    return <InlineError message={load.message} />;
  }

  const { exam } = load.data;

  if (exam.status === "CREATED") {
    return (
      <Card className="text-center">
        <p className="text-sm text-fg-muted">
          {exam.questionCount} questions{exam.timeLimitSeconds ? ` · ${Math.round(exam.timeLimitSeconds / 60)} min` : ""}
        </p>
        <div className="mt-4">
          <Button variant="primary" size="lg" loading={starting} onClick={() => void start()}>
            {starting ? "Starting…" : "Begin Exam"}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between border-b border-border pb-3">
        <p className="text-sm font-medium text-fg-muted">
          Question {index + 1} / {questions.length}
        </p>
        {tickSeconds != null && (
          <p
            role="timer"
            aria-label={`Time remaining: ${formatTime(tickSeconds)}`}
            className={`font-mono text-sm ${tickSeconds < 60 ? "font-semibold text-danger" : "text-fg-muted"}`}
          >
            {formatTime(tickSeconds)}
          </p>
        )}
      </div>
      {lowTimeRemaining && (
        <span className="sr-only" role="status" aria-live="polite">
          Less than one minute remaining.
        </span>
      )}
      <div className="mt-3">
        <ProgressBar value={questions.length > 0 ? (index + (current?.answered ? 1 : 0)) / questions.length : 0} label="Exam progress" />
      </div>

      {current && (
        <div className="animate-fade-in mt-6">
          {current.scenario && (
            <Card padding="sm" className="mb-4 bg-surface-muted">
              <p className="font-medium text-fg">{current.scenario.context}</p>
              <p className="mt-2 text-sm text-fg-muted">Objective: {current.scenario.objective}</p>
              {current.scenario.constraints.length > 0 && (
                <ul className="mt-2 list-inside list-disc text-sm text-fg-muted">
                  {current.scenario.constraints.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          <p className="text-lg leading-relaxed text-fg">{current.prompt}</p>

          <div className="mt-4">
            {current.options ? (
              <div className="space-y-2">
                {current.options.map((opt) => {
                  const multi = current.questionType === "MULTI_SELECT";
                  const checked = draft.selectedOptionIds.includes(opt.id);
                  return (
                    <label
                      key={opt.id}
                      className={`transition-standard flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                        checked ? "border-accent bg-surface-muted" : "border-border"
                      }`}
                    >
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
                        className="focus-ring accent-accent"
                      />
                      {opt.text}
                    </label>
                  );
                })}
              </div>
            ) : (
              <Textarea
                value={draft.answerText}
                onChange={(e) => updateDraft(current.id, { answerText: e.target.value })}
                rows={6}
                placeholder="Your answer…"
              />
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-xs text-fg-subtle">Confidence:</span>
            {(["GUESSING", "UNSURE", "CONFIDENT"] as const).map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={draft.confidence === level}
                onClick={() => updateDraft(current.id, { confidence: draft.confidence === level ? null : level })}
                className={`focus-ring transition-standard rounded-full px-2.5 py-1 text-xs ${
                  draft.confidence === level ? "bg-accent text-accent-fg" : "border border-border text-fg-muted hover:bg-surface-hover"
                }`}
              >
                {CONFIDENCE_LABEL[level]}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4">
          <InlineError message={error} />
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0}>
          Previous
        </Button>
        <Button variant="primary" loading={saving} onClick={() => void saveAndAdvance()}>
          {saving ? "Saving…" : "Save & Next"}
        </Button>
      </div>

      <div className="mt-6 border-t border-border pt-4 text-center">
        {confirmSubmit || unansweredCount === 0 ? (
          <div>
            {unansweredCount > 0 && (
              <p className="mb-2 text-sm text-warning">
                {unansweredCount} question{unansweredCount === 1 ? "" : "s"} unanswered.
              </p>
            )}
            <div className="flex items-center justify-center gap-3">
              <Button variant="primary" loading={submitting} onClick={() => void finalSubmit()}>
                {submitting ? "Submitting…" : "Submit Exam"}
              </Button>
              {confirmSubmit && (
                <Button variant="ghost" size="sm" onClick={() => setConfirmSubmit(false)}>
                  Return to questions
                </Button>
              )}
            </div>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirmSubmit(true)}>
            Finish and submit
          </Button>
        )}
      </div>
    </div>
  );
}
