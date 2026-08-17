"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Textarea } from "@/components/ui/Input";
import { InlineError } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";

type Correctness = "SUCCESS" | "PARTIAL" | "FAILURE";
type EvaluationStatus = "PENDING" | "EVALUATING" | "COMPLETED" | "FAILED" | "TIMEOUT";

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
    return <LoadingState label="Loading Active Recall" />;
  }

  if (phase === "fatal") {
    return (
      <div className="animate-fade-in">
        <InlineError message={error ?? "Something went wrong."} />
        <Link href={`/courses/${courseId}`} className="focus-ring mt-4 inline-block text-sm text-fg-muted hover:text-fg hover:underline">
          ← Back to course
        </Link>
      </div>
    );
  }

  if (phase === "idle") {
    return (
      <Card padding="lg" className="animate-fade-in text-center">
        <h1 className="text-xl font-semibold text-fg">Active Recall</h1>
        <p className="mt-2 text-sm text-fg-muted">Answer questions from memory before seeing the explanation — {courseTitle}.</p>
        {error && (
          <div className="mt-3">
            <InlineError message={error} />
          </div>
        )}
        <div className="mt-5">
          <Button variant="primary" size="lg" loading={isBusy} onClick={startSession}>
            {isBusy ? "Starting…" : "Start Active Recall"}
          </Button>
        </div>
      </Card>
    );
  }

  if (phase === "summary") {
    return <SessionSummaryView summary={summary} courseId={courseId} />;
  }

  if (!session || !sessionQuestion) {
    return <LoadingState />;
  }

  const isAnswering = phase === "question" || phase === "submitting";
  const questionNumber = session.questionsAnswered + (isAnswering ? 1 : 0);

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between gap-4 text-sm text-fg-muted">
        <span className="font-medium text-fg">{courseTitle}</span>
        <span>
          Question {questionNumber} / {session.targetLength}
        </span>
      </div>
      <ProgressBar
        value={(questionNumber - 1) / session.targetLength}
        className="mt-2"
        label={`Question ${questionNumber} of ${session.targetLength}`}
      />

      {/* The question is the dominant visual element (spec 18.5) — larger type, generous spacing, everything else recedes below it. */}
      <Card padding="lg" className="animate-slide-up mt-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-fg">{sessionQuestion.question.concept.name}</h2>
          <Badge tone="neutral">Difficulty {sessionQuestion.question.difficulty}/5</Badge>
        </div>
        {sessionQuestion.reason && (
          <details className="mt-1.5">
            <summary className="focus-ring cursor-pointer text-xs text-fg-subtle">Why this question?</summary>
            <p className="mt-1 text-xs text-fg-muted">{sessionQuestion.reason}</p>
          </details>
        )}

        <p className="mt-5 text-lg leading-relaxed text-fg">{sessionQuestion.question.prompt}</p>

        {isAnswering && (
          <>
            <Textarea
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              disabled={phase === "submitting"}
              rows={5}
              placeholder="Your answer…"
              aria-label="Your answer"
              className="mt-5 text-base"
            />

            {hint && (
              <div className="animate-slide-up mt-3 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-fg">
                💡 {hint}
              </div>
            )}

            <div className="mt-4 flex items-center gap-2 text-sm text-fg-muted">
              <span>Confidence:</span>
              <div className="flex gap-1.5">
                {[1, 2, 3, 4, 5].map((level) => (
                  <button
                    key={level}
                    type="button"
                    disabled={phase === "submitting"}
                    onClick={() => setConfidence((c) => (c === level ? null : level))}
                    aria-pressed={confidence === level}
                    aria-label={`Confidence ${level} out of 5`}
                    className={`focus-ring transition-standard h-7 w-7 rounded-full border text-xs font-medium ${
                      confidence === level ? "border-accent bg-accent text-accent-fg" : "border-border text-fg-muted hover:bg-surface-hover"
                    }`}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <div className="mt-3">
                <InlineError message={error} />
              </div>
            )}

            <div className="mt-5 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={isBusy || phase === "submitting"} onClick={requestHint}>
                  Hint
                </Button>
                <Button variant="ghost" size="sm" disabled={isBusy || phase === "submitting"} onClick={revealAnswer}>
                  Reveal Answer
                </Button>
              </div>
              <Button
                variant="primary"
                size="lg"
                loading={phase === "submitting"}
                disabled={answerText.trim().length === 0}
                onClick={() => void submitAnswer()}
              >
                {phase === "submitting" ? "Saving…" : "Submit"}
              </Button>
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
      </Card>
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
    <div className="animate-slide-up mt-5 border-t border-border pt-5">
      <p className="text-xs font-medium tracking-wide text-fg-subtle uppercase">Your answer</p>
      <p className="mt-1 text-sm whitespace-pre-wrap text-fg">{answerText}</p>

      {modelAnswer && (
        <div className="mt-4">
          <p className="text-xs font-medium tracking-wide text-fg-subtle uppercase">Model answer</p>
          <p className="mt-1 text-sm whitespace-pre-wrap text-fg">{modelAnswer}</p>
        </div>
      )}

      {rubric.length > 0 && (
        <ul className="mt-2 list-inside list-disc text-xs text-fg-muted">
          {rubric.map((point, i) => (
            <li key={i}>{point}</li>
          ))}
        </ul>
      )}

      <p role="status" className="mt-4 flex items-center gap-2 text-sm text-fg-muted">
        <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
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
    <div className="animate-slide-up mt-5 border-t border-border pt-5">
      <p className="text-xs font-medium tracking-wide text-fg-subtle uppercase">Your answer</p>
      <p className="mt-1 text-sm whitespace-pre-wrap text-fg">{answerText}</p>

      {modelAnswer && (
        <div className="mt-4">
          <p className="text-xs font-medium tracking-wide text-fg-subtle uppercase">Model answer</p>
          <p className="mt-1 text-sm whitespace-pre-wrap text-fg">{modelAnswer}</p>
        </div>
      )}

      <div role="alert" className="mt-4 rounded-md border border-warning-border bg-warning-bg p-3 text-sm">
        <p className="font-medium text-warning-fg">
          {timedOut ? "We couldn't evaluate your answer in time." : "We couldn't evaluate your answer right now."}
        </p>
        <p className="mt-1 text-warning-fg/90">Your answer has been saved. The model answer is shown above.</p>
      </div>

      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" disabled={isBusy} onClick={onContinue}>
          Continue
        </Button>
        <Button variant="primary" disabled={isBusy} onClick={onRetry}>
          Retry evaluation
        </Button>
      </div>
    </div>
  );
}

const CORRECTNESS_LABEL: Record<Correctness, string> = { SUCCESS: "Correct", PARTIAL: "Partially correct", FAILURE: "Needs review" };
const CORRECTNESS_TONE: Record<Correctness, BadgeTone> = { SUCCESS: "success", PARTIAL: "warning", FAILURE: "danger" };

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
    <div className="animate-slide-up mt-5 border-t border-border pt-5">
      <div className="flex items-center gap-3">
        {answer.correctness && <Badge tone={CORRECTNESS_TONE[answer.correctness]}>{CORRECTNESS_LABEL[answer.correctness]}</Badge>}
        <p className="text-lg font-semibold text-fg">Score: {scoreLabel(answer.score)}</p>
      </div>

      {answer.strengths && answer.strengths.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-medium text-success">✓ What you got right</p>
          <ul className="mt-1 list-inside list-disc text-sm text-fg-muted">
            {answer.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      {answer.missingPoints && answer.missingPoints.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-medium text-warning">⚠ What is missing</p>
          <ul className="mt-1 list-inside list-disc text-sm text-fg-muted">
            {answer.missingPoints.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      {((answer.errors && answer.errors.length > 0) || (answer.misconceptions && answer.misconceptions.length > 0)) && (
        <div className="mt-3">
          <p className="text-sm font-medium text-danger">✕ What needs correction</p>
          <ul className="mt-1 list-inside list-disc text-sm text-fg-muted">
            {answer.errors?.map((e, i) => (
              <li key={`e-${i}`}>{e.description}</li>
            ))}
            {answer.misconceptions?.map((m, i) => (
              <li key={`m-${i}`}>{m.description} (misconception)</li>
            ))}
          </ul>
        </div>
      )}

      {answer.feedback && <p className="mt-3 text-sm text-fg">{answer.feedback}</p>}

      {answer.correctAnswer && (
        <div className="mt-3">
          <p className="text-sm font-medium text-fg-muted">Explanation</p>
          <p className="mt-1 text-sm text-fg">{answer.correctAnswer}</p>
        </div>
      )}

      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {allowRetry && (
          <Button variant="secondary" disabled={isBusy} onClick={onTryAgain}>
            Try Again
          </Button>
        )}
        <Button variant="primary" size="lg" loading={isBusy} onClick={isLastQuestion ? onFinish : onNext}>
          {isLastQuestion ? "Finish Session" : "Next Question"}
        </Button>
      </div>
    </div>
  );
}

function SessionSummaryView({ summary, courseId }: { summary: SummaryDTO | null; courseId: string }) {
  return (
    <Card padding="lg" className="animate-fade-in">
      <h1 className="text-xl font-semibold text-fg">Session Complete</h1>
      {summary ? (
        <>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <StatCard label="Questions" value={summary.questionsAnswered} />
            <StatCard label="Correct" value={summary.questionsCorrect} tone="success" />
            <StatCard label="Average score" value={`${Math.round(summary.averageScore * 100)}%`} />
          </div>

          <div className="mt-6">
            <p className="text-sm font-medium text-fg-muted">Concepts practiced</p>
            <p className="mt-1 text-sm text-fg">{summary.conceptsPracticed.length > 0 ? summary.conceptsPracticed.join(", ") : "None"}</p>
          </div>

          <div className="mt-4">
            <p className="text-sm font-medium text-fg-muted">Current weak areas</p>
            <p className="mt-1 text-sm text-fg">{summary.weakAreas.length > 0 ? summary.weakAreas.join(", ") : "None right now."}</p>
          </div>

          {summary.mistakeCount > 0 && (
            <p className="mt-4 text-sm text-fg-muted">
              {summary.mistakeCount} mistake{summary.mistakeCount === 1 ? "" : "s"} recorded this session — review them from the course
              knowledge page.
            </p>
          )}
        </>
      ) : (
        <p className="mt-2 text-sm text-fg-muted">Summary unavailable.</p>
      )}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Link href={`/courses/${courseId}/study/recall`}>
          <Button variant="primary">Start another session</Button>
        </Link>
        <Link href={`/courses/${courseId}`}>
          <Button variant="secondary">Back to course</Button>
        </Link>
      </div>
    </Card>
  );
}
