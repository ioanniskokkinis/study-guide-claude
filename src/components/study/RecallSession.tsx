"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Correctness = "SUCCESS" | "PARTIAL" | "FAILURE";
type EvaluationStatus = "PENDING" | "COMPLETED" | "FAILED" | "TIMEOUT";

interface QuestionDTO {
  id: string;
  type: string;
  difficulty: number;
  prompt: string;
  /** Always persisted with the question itself (Phase 17 §7) — never requires a Claude call to show. */
  expectedAnswer: string | null;
  rubric: unknown;
}

function rubricPoints(rubric: unknown): string[] {
  return Array.isArray(rubric) ? rubric.filter((item): item is string => typeof item === "string") : [];
}

interface AnswerDTO {
  id: string;
  answerText: string;
  score: number | null;
  correctness: Correctness | null;
  strengths: string[] | null;
  missingPoints: string[] | null;
  errors: Array<{ category: string; description: string; severity: string }> | null;
  misconceptions: Array<{ description: string; severity: string }> | null;
  feedback: string | null;
  correctAnswer: string | null;
  needsRemediation: boolean;
  evaluationError: string | null;
  evaluationStatus: EvaluationStatus;
  revealedAnswer: boolean;
}

interface SessionQuestionDTO {
  id: string;
  answeredAt: string | null;
  hintsUsed: number;
  revealed: boolean;
  reason: string | null;
  question: QuestionDTO & { concept: { name: string } };
  answer?: AnswerDTO | null;
}

interface SessionDTO {
  id: string;
  status: "ACTIVE" | "COMPLETED" | "ABANDONED";
  targetLength: number;
  questionsAnswered: number;
  questionsCorrect: number;
}

interface SessionStateDTO {
  session: SessionDTO;
  currentSessionQuestion: SessionQuestionDTO | null;
}

interface SummaryDTO {
  questionsAnswered: number;
  questionsCorrect: number;
  averageScore: number;
  conceptsPracticed: string[];
  weakAreas: string[];
  mistakeCount: number;
}

/**
 * Explicit state machine (Phase 17 §33) — every state has a way out. The
 * critical addition over the old two-state "question"/"evaluating" model is
 * that submitting an answer no longer waits on Claude at all: "evaluating"
 * already has the student's answer and the model answer on screen, and
 * always resolves to one of feedback/eval_timeout/eval_error, never stays
 * "evaluating" forever (§2).
 */
type Phase =
  | "checking"
  | "idle"
  | "question"
  | "submitting"
  | "evaluating"
  | "feedback"
  | "eval_timeout"
  | "eval_error"
  | "summary"
  | "fatal";

async function parseJson(response: Response) {
  return response.json().catch(() => ({}));
}

export function RecallSession({ courseId, courseTitle }: { courseId: string; courseTitle: string }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [session, setSession] = useState<SessionDTO | null>(null);
  const [sessionQuestion, setSessionQuestion] = useState<SessionQuestionDTO | null>(null);
  const [summary, setSummary] = useState<SummaryDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const [answerText, setAnswerText] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);

  useEffect(() => {
    void resumeIfActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  async function resumeIfActive() {
    try {
      const activeResponse = await fetch(`/api/courses/${courseId}/study/recall/active`);
      const { sessionId } = await parseJson(activeResponse);
      if (!sessionId) {
        setPhase("idle");
        return;
      }
      const stateResponse = await fetch(`/api/study-sessions/${sessionId}`);
      const state: SessionStateDTO = await parseJson(stateResponse);
      if (!stateResponse.ok) {
        setPhase("idle");
        return;
      }
      applyState(state);
    } catch {
      setPhase("idle");
    }
  }

  function applyState(state: SessionStateDTO) {
    setSession(state.session);
    setSessionQuestion(state.currentSessionQuestion);
    setHint(null);
    setConfidence(null);
    setError(null);

    if (state.session.status !== "ACTIVE") {
      void loadSummary(state.session.id);
      return;
    }

    const sq = state.currentSessionQuestion;
    if (!sq || !sq.answeredAt) {
      setAnswerText("");
      setPhase("question");
      return;
    }

    // Already answered — resume into whichever post-submit state matches
    // persisted evaluation status, rather than always defaulting back to
    // an empty question form (spec §21's "survives refresh" now also
    // covers mid-evaluation and post-timeout/error states).
    setAnswerText(sq.answer?.answerText ?? "");
    const status = sq.answer?.evaluationStatus;
    if (sq.revealed || status === "COMPLETED") {
      setPhase("feedback");
    } else if (status === "TIMEOUT") {
      setPhase("eval_timeout");
    } else if (status === "FAILED") {
      setPhase("eval_error");
    } else if (sq.answer) {
      setPhase("evaluating");
      void runEvaluation(state.session.id, sq.id);
    } else {
      setPhase("question");
    }
  }

  async function loadSummary(sessionId: string) {
    const response = await fetch(`/api/study-sessions/${sessionId}/summary`);
    const body = await parseJson(response);
    if (response.ok) setSummary(body);
    setPhase("summary");
  }

  async function startSession() {
    setError(null);
    setIsBusy(true);
    try {
      const response = await fetch(`/api/courses/${courseId}/study/recall/session`, { method: "POST" });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not start Active Recall.");
      applyState(body as SessionStateDTO);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start Active Recall.");
      setPhase("fatal");
    } finally {
      setIsBusy(false);
    }
  }

  /**
   * Submits the answer and shows the model answer immediately (Phase 17
   * §12) — this call never waits on Claude. If the exact-match deterministic
   * fast path already settled it server-side, jump straight to feedback;
   * otherwise move into "evaluating" (answer + model answer already
   * visible) and kick off the separate evaluate call automatically.
   */
  async function submitAnswer() {
    if (!session || !sessionQuestion || answerText.trim().length === 0) return;
    setError(null);
    setPhase("submitting");
    setIsBusy(true);
    try {
      const response = await fetch(`/api/study-sessions/${session.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionQuestionId: sessionQuestion.id,
          answerText,
          confidence: confidence ?? undefined,
        }),
      });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not save this answer.");

      setSession(body.session);
      const answer = body.answer as AnswerDTO;
      setSessionQuestion({ ...sessionQuestion, answeredAt: new Date().toISOString(), answer });

      if (answer.evaluationStatus === "COMPLETED") {
        setPhase("feedback");
      } else {
        setPhase("evaluating");
        void runEvaluation(session.id, sessionQuestion.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this answer.");
      setPhase("question");
    } finally {
      setIsBusy(false);
    }
  }

  /**
   * Separate from submission (Phase 17 §13) — safe to call multiple times
   * (idempotent server-side, §18): a timeout/failure just settles the
   * answer into a terminal, retryable state instead of throwing, so this
   * never needs to distinguish "first attempt" from "retry."
   */
  async function runEvaluation(sessionId: string, sessionQuestionId: string) {
    try {
      const response = await fetch(`/api/study-sessions/${sessionId}/answer/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionQuestionId }),
      });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not evaluate this answer.");

      const answer = body.answer as AnswerDTO;
      setSession(body.session);
      setSessionQuestion((prev) => (prev ? { ...prev, answer } : prev));

      if (answer.evaluationStatus === "COMPLETED") setPhase("feedback");
      else if (answer.evaluationStatus === "TIMEOUT") setPhase("eval_timeout");
      else setPhase("eval_error");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not evaluate this answer.");
      setPhase("eval_error");
    }
  }

  async function requestHint() {
    if (!session || !sessionQuestion) return;
    setIsBusy(true);
    try {
      const response = await fetch(`/api/study-sessions/${session.id}/hint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionQuestionId: sessionQuestion.id }),
      });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not get a hint.");
      setHint(body.hint);
      setSessionQuestion({ ...sessionQuestion, hintsUsed: body.hintsUsed });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not get a hint.");
    } finally {
      setIsBusy(false);
    }
  }

  async function revealAnswer() {
    if (!session || !sessionQuestion) return;
    if (!confirm("Revealing the answer will not count as a normal attempt. Continue?")) return;
    setIsBusy(true);
    try {
      const response = await fetch(`/api/study-sessions/${session.id}/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionQuestionId: sessionQuestion.id }),
      });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not reveal the answer.");
      setSession(body.session);
      setSessionQuestion({
        ...sessionQuestion,
        revealed: true,
        answer: {
          id: "",
          answerText: "",
          score: 0,
          correctness: "FAILURE",
          strengths: [],
          missingPoints: [],
          errors: [],
          misconceptions: [],
          feedback: "You revealed the answer instead of attempting retrieval.",
          correctAnswer: body.correctAnswer,
          needsRemediation: false,
          evaluationError: null,
          evaluationStatus: "COMPLETED",
          revealedAnswer: true,
        },
      });
      setPhase("feedback");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reveal the answer.");
    } finally {
      setIsBusy(false);
    }
  }

  async function goNext(retry: boolean) {
    if (!session) return;
    setError(null);
    setIsBusy(true);
    try {
      if (session.questionsAnswered >= session.targetLength) {
        await loadSummary(session.id);
        return;
      }
      const response = await fetch(`/api/study-sessions/${session.id}/next`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retry }),
      });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not load the next question.");
      setSessionQuestion(body.sessionQuestion as SessionQuestionDTO);
      setHint(null);
      setAnswerText("");
      setConfidence(null);
      setPhase("question");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the next question.");
    } finally {
      setIsBusy(false);
    }
  }

  async function finishSession() {
    if (!session) return;
    setIsBusy(true);
    try {
      const response = await fetch(`/api/study-sessions/${session.id}/complete`, { method: "POST" });
      const body = await parseJson(response);
      if (response.ok) setSummary(body);
      setPhase("summary");
    } finally {
      setIsBusy(false);
    }
  }

  if (phase === "checking") {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  if (phase === "fatal") {
    return (
      <div>
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        <Link href={`/courses/${courseId}`} className="mt-4 inline-block text-sm text-zinc-500 hover:underline">
          ← Back to course
        </Link>
      </div>
    );
  }

  if (phase === "idle") {
    return (
      <div className="rounded-lg border border-zinc-200 p-6 text-center dark:border-zinc-800">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Active Recall</h1>
        <p className="mt-2 text-sm text-zinc-500">
          Answer questions from memory before seeing the explanation — {courseTitle}.
        </p>
        {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <button
          type="button"
          onClick={startSession}
          disabled={isBusy}
          className="mt-4 rounded-md bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-70 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {isBusy ? "Starting…" : "Start Active Recall"}
        </button>
      </div>
    );
  }

  if (phase === "summary") {
    return <SessionSummaryView summary={summary} courseId={courseId} />;
  }

  if (!session || !sessionQuestion) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  const isAnswering = phase === "question" || phase === "submitting";

  return (
    <div>
      <div className="flex items-center justify-between text-sm text-zinc-500">
        <span>{courseTitle}</span>
        <span>
          Question {session.questionsAnswered + (isAnswering ? 1 : 0)} / {session.targetLength}
        </span>
      </div>

      <div className="mt-4 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{sessionQuestion.question.concept.name}</h2>
          <span className="text-xs text-zinc-400">Difficulty: {sessionQuestion.question.difficulty}/5</span>
        </div>
        {sessionQuestion.reason && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-zinc-400">Why this question?</summary>
            <p className="mt-1 text-xs text-zinc-500">{sessionQuestion.reason}</p>
          </details>
        )}

        <p className="mt-4 text-zinc-800 dark:text-zinc-200">{sessionQuestion.question.prompt}</p>

        {isAnswering && (
          <>
            <textarea
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              disabled={phase === "submitting"}
              rows={5}
              placeholder="Your answer…"
              className="mt-4 w-full rounded-md border border-zinc-300 p-3 text-sm dark:border-zinc-700 dark:bg-transparent"
            />

            {hint && (
              <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                💡 {hint}
              </p>
            )}

            <div className="mt-3 flex items-center gap-2 text-sm text-zinc-500">
              <span>Confidence:</span>
              {[1, 2, 3, 4, 5].map((level) => (
                <button
                  key={level}
                  type="button"
                  disabled={phase === "submitting"}
                  onClick={() => setConfidence((c) => (c === level ? null : level))}
                  className={`h-7 w-7 rounded-full border text-xs font-medium ${
                    confidence === level
                      ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                      : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900"
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>

            {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

            <div className="mt-4 flex items-center justify-between">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={requestHint}
                  disabled={isBusy || phase === "submitting"}
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  Hint
                </button>
                <button
                  type="button"
                  onClick={revealAnswer}
                  disabled={isBusy || phase === "submitting"}
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  Reveal Answer
                </button>
              </div>
              <button
                type="button"
                onClick={() => void submitAnswer()}
                disabled={phase === "submitting" || answerText.trim().length === 0}
                className="rounded-md bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {phase === "submitting" ? "Saving…" : "Submit"}
              </button>
            </div>
          </>
        )}

        {phase === "evaluating" && (
          <EvaluatingView
            answerText={answerText}
            modelAnswer={sessionQuestion.question.expectedAnswer}
            rubric={rubricPoints(sessionQuestion.question.rubric)}
          />
        )}

        {(phase === "eval_timeout" || phase === "eval_error") && (
          <EvalFailureView
            answerText={answerText}
            modelAnswer={sessionQuestion.question.expectedAnswer}
            timedOut={phase === "eval_timeout"}
            isBusy={isBusy}
            onRetry={() => {
              setPhase("evaluating");
              void runEvaluation(session.id, sessionQuestion.id);
            }}
            onContinue={() => void goNext(false)}
          />
        )}

        {phase === "feedback" && sessionQuestion.answer && (
          <FeedbackView
            answer={sessionQuestion.answer}
            isBusy={isBusy}
            onTryAgain={() => goNext(true)}
            onNext={() => goNext(false)}
            onFinish={finishSession}
            isLastQuestion={session.questionsAnswered >= session.targetLength}
          />
        )}
      </div>
    </div>
  );
}

function scoreLabel(score: number | null): string {
  if (score == null) return "—";
  return `${Math.round(score * 100)}%`;
}

/** Shown the instant an answer is submitted (Phase 17 §12): the student's own answer and the model answer, both already persisted — never waiting on Claude to appear. */
function EvaluatingView({ answerText, modelAnswer, rubric }: { answerText: string; modelAnswer: string | null; rubric: string[] }) {
  return (
    <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Your answer</p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">{answerText}</p>

      {modelAnswer && (
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Model answer</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">{modelAnswer}</p>
        </div>
      )}

      {rubric.length > 0 && (
        <ul className="mt-2 list-inside list-disc text-xs text-zinc-500">
          {rubric.map((point, i) => (
            <li key={i}>{point}</li>
          ))}
        </ul>
      )}

      <p className="mt-4 flex items-center gap-2 text-sm text-zinc-500">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-zinc-400" />
        Evaluating your answer…
      </p>
    </div>
  );
}

/** Recoverable UI for a timeout or evaluation failure (Phase 17 §16/§36) — the answer and model answer stay visible, nothing is fabricated, and the student can always retry or move on. */
function EvalFailureView({
  answerText,
  modelAnswer,
  timedOut,
  isBusy,
  onRetry,
  onContinue,
}: {
  answerText: string;
  modelAnswer: string | null;
  timedOut: boolean;
  isBusy: boolean;
  onRetry: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Your answer</p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">{answerText}</p>

      {modelAnswer && (
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Model answer</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">{modelAnswer}</p>
        </div>
      )}

      <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
        <p className="font-medium text-amber-800 dark:text-amber-300">
          {timedOut ? "We couldn't evaluate your answer in time." : "We couldn't evaluate your answer right now."}
        </p>
        <p className="mt-1 text-amber-700 dark:text-amber-400">Your answer has been saved. The model answer is shown above.</p>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onContinue}
          disabled={isBusy}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Continue
        </button>
        <button
          type="button"
          onClick={onRetry}
          disabled={isBusy}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Retry evaluation
        </button>
      </div>
    </div>
  );
}

function FeedbackView({
  answer,
  isBusy,
  onTryAgain,
  onNext,
  onFinish,
  isLastQuestion,
}: {
  answer: AnswerDTO;
  isBusy: boolean;
  onTryAgain: () => void;
  onNext: () => void;
  onFinish: () => void;
  isLastQuestion: boolean;
}) {
  const allowRetry = !answer.revealedAnswer && answer.correctness !== "SUCCESS";

  return (
    <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Score: {scoreLabel(answer.score)}</p>

      {answer.strengths && answer.strengths.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">✓ What you got right</p>
          <ul className="mt-1 list-inside list-disc text-sm text-zinc-600 dark:text-zinc-400">
            {answer.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      {answer.missingPoints && answer.missingPoints.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">⚠ What is missing</p>
          <ul className="mt-1 list-inside list-disc text-sm text-zinc-600 dark:text-zinc-400">
            {answer.missingPoints.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      {((answer.errors && answer.errors.length > 0) || (answer.misconceptions && answer.misconceptions.length > 0)) && (
        <div className="mt-3">
          <p className="text-sm font-medium text-red-700 dark:text-red-400">❌ What needs correction</p>
          <ul className="mt-1 list-inside list-disc text-sm text-zinc-600 dark:text-zinc-400">
            {answer.errors?.map((e, i) => (
              <li key={`e-${i}`}>{e.description}</li>
            ))}
            {answer.misconceptions?.map((m, i) => (
              <li key={`m-${i}`}>{m.description} (misconception)</li>
            ))}
          </ul>
        </div>
      )}

      {answer.feedback && <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">{answer.feedback}</p>}

      {answer.correctAnswer && (
        <div className="mt-3">
          <p className="text-sm font-medium text-zinc-500">Explanation</p>
          <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{answer.correctAnswer}</p>
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        {allowRetry && (
          <button
            type="button"
            onClick={onTryAgain}
            disabled={isBusy}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Try Again
          </button>
        )}
        <button
          type="button"
          onClick={isLastQuestion ? onFinish : onNext}
          disabled={isBusy}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {isLastQuestion ? "Finish Session" : "Next Question"}
        </button>
      </div>
    </div>
  );
}

function SessionSummaryView({ summary, courseId }: { summary: SummaryDTO | null; courseId: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Session Complete</h1>
      {summary ? (
        <>
          <dl className="mt-4 grid grid-cols-3 gap-4 text-center">
            <div>
              <dt className="text-xs text-zinc-400">Questions</dt>
              <dd className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{summary.questionsAnswered}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400">Correct</dt>
              <dd className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{summary.questionsCorrect}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400">Average score</dt>
              <dd className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
                {Math.round(summary.averageScore * 100)}%
              </dd>
            </div>
          </dl>

          <div className="mt-6">
            <p className="text-sm font-medium text-zinc-500">Concepts practiced</p>
            <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
              {summary.conceptsPracticed.length > 0 ? summary.conceptsPracticed.join(", ") : "None"}
            </p>
          </div>

          <div className="mt-4">
            <p className="text-sm font-medium text-zinc-500">Current weak areas</p>
            <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
              {summary.weakAreas.length > 0 ? summary.weakAreas.join(", ") : "None right now."}
            </p>
          </div>

          {summary.mistakeCount > 0 && (
            <p className="mt-4 text-sm text-zinc-500">
              {summary.mistakeCount} mistake{summary.mistakeCount === 1 ? "" : "s"} recorded this session — review them
              from the course knowledge page.
            </p>
          )}
        </>
      ) : (
        <p className="mt-2 text-sm text-zinc-500">Summary unavailable.</p>
      )}

      <div className="mt-6 flex gap-3">
        <Link
          href={`/courses/${courseId}/study/recall`}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Start another session
        </Link>
        <Link
          href={`/courses/${courseId}`}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Back to course
        </Link>
      </div>
    </div>
  );
}
