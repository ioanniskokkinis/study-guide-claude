"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatRelativeDays } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Textarea } from "@/components/ui/Input";
import { InlineError, ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";

type Correctness = "SUCCESS" | "PARTIAL" | "FAILURE";
type ReviewOutcomeValue = "AGAIN" | "HARD" | "GOOD" | "EASY";

interface QuestionDTO {
  id: string;
  conceptId: string;
  difficulty: number;
  prompt: string;
}

type EvaluationStatus = "PENDING" | "EVALUATING" | "COMPLETED" | "FAILED" | "TIMEOUT";

interface AnswerDTO {
  id: string;
  score: number | null;
  correctness: Correctness | null;
  feedback: string | null;
  correctAnswer: string | null;
  revealedAnswer: boolean;
  evaluationStatus: EvaluationStatus;
}

interface SessionQuestionDTO {
  id: string;
  answeredAt: string | null;
  reason: string | null;
  question: QuestionDTO & { concept: { name: string } };
  answer?: AnswerDTO | null;
}

interface SessionDTO {
  id: string;
  status: "ACTIVE" | "COMPLETED" | "ABANDONED";
  targetLength: number;
  questionsAnswered: number;
}

interface SessionStateDTO {
  session: SessionDTO;
  currentSessionQuestion: SessionQuestionDTO | null;
  dueCount?: number;
}

interface ReviewStateDTO {
  dueCount: number;
  overdueCount: number;
  reviewStreak: number;
}

interface RatingResultDTO {
  reviewItem: { nextReviewAt: string; interval: number };
  alreadyRated: boolean;
}

interface ReviewSummaryDTO {
  reviewed: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
  nextReviewAt: string | null;
}

type Phase =
  | "checking"
  | "idle"
  | "nothing-due"
  | "question"
  | "evaluating"
  | "eval_timeout"
  | "eval_error"
  | "feedback"
  | "rating"
  | "rated"
  | "summary"
  | "fatal";

const CORRECTNESS_TONE: Record<Correctness, BadgeTone> = { SUCCESS: "success", PARTIAL: "warning", FAILURE: "danger" };

async function parseJson(response: Response) {
  return response.json().catch(() => ({}));
}

function formatNextReview(iso: string | null): string {
  return iso ? formatRelativeDays(new Date(iso)) : "—";
}

export function ReviewRunner({ courseId, courseTitle }: { courseId: string; courseTitle: string }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [session, setSession] = useState<SessionDTO | null>(null);
  const [sessionQuestion, setSessionQuestion] = useState<SessionQuestionDTO | null>(null);
  const [dueState, setDueState] = useState<ReviewStateDTO | null>(null);
  const [summary, setSummary] = useState<ReviewSummaryDTO | null>(null);
  const [ratingResult, setRatingResult] = useState<RatingResultDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const [answerText, setAnswerText] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);

  useEffect(() => {
    void resumeIfActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  async function resumeIfActive() {
    try {
      const activeResponse = await fetch(`/api/courses/${courseId}/review/active`);
      const { sessionId } = await parseJson(activeResponse);
      if (!sessionId) {
        await loadDueState();
        return;
      }
      const stateResponse = await fetch(`/api/study-sessions/${sessionId}`);
      const state: SessionStateDTO = await parseJson(stateResponse);
      if (!stateResponse.ok) {
        await loadDueState();
        return;
      }
      applyState(state);
    } catch {
      await loadDueState();
    }
  }

  async function loadDueState() {
    try {
      const response = await fetch(`/api/courses/${courseId}/review/state`);
      const body: ReviewStateDTO = await parseJson(response);
      setDueState(response.ok ? body : null);
    } finally {
      setPhase("idle");
    }
  }

  function applyState(state: SessionStateDTO) {
    setSession(state.session);
    setSessionQuestion(state.currentSessionQuestion);
    setAnswerText("");
    setConfidence(null);
    setRatingResult(null);
    setHint(null);

    if (state.session.status !== "ACTIVE") {
      void loadSummary(state.session.id);
      return;
    }
    const sq = state.currentSessionQuestion;
    if (sq?.answeredAt != null && sq?.answer) {
      const status = sq.answer.evaluationStatus;
      if (status === "COMPLETED" || sq.answer.revealedAnswer) {
        setPhase("rating");
      } else if (status === "TIMEOUT") {
        setPhase("eval_timeout");
      } else if (status === "FAILED") {
        setPhase("eval_error");
      } else {
        setPhase("evaluating");
        void runEvaluation(state.session.id, sq.id);
      }
    } else {
      setPhase("question");
    }
  }

  /** Separate from submission (Phase 17 §13) — safe to call more than once (idempotent server-side). Rating requires a COMPLETED evaluation since it's what creates the underlying LearningAttempt a review rating attaches to; TIMEOUT/FAILED offers Retry rather than a Continue-without-evaluation path (unlike Active Recall, Review has no meaningful "rate without evidence" state). */
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

      if (answer.evaluationStatus === "COMPLETED") setPhase("rating");
      else if (answer.evaluationStatus === "TIMEOUT") setPhase("eval_timeout");
      else setPhase("eval_error");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not evaluate this answer.");
      setPhase("eval_error");
    }
  }

  async function loadSummary(sessionId: string) {
    const response = await fetch(`/api/review-sessions/${sessionId}/summary`);
    const body = await parseJson(response);
    if (response.ok) setSummary(body);
    setPhase("summary");
  }

  async function startSession() {
    setError(null);
    setIsBusy(true);
    try {
      const response = await fetch(`/api/courses/${courseId}/review/start`, { method: "POST" });
      const body = await parseJson(response);
      if (!response.ok) {
        if (response.status === 422) {
          setPhase("nothing-due");
          return;
        }
        throw new Error(body.error ?? "Could not start the review session.");
      }
      applyState(body as SessionStateDTO);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the review session.");
      setPhase("fatal");
    } finally {
      setIsBusy(false);
    }
  }

  async function submitAnswer() {
    if (!session || !sessionQuestion || answerText.trim().length === 0) return;
    setError(null);
    setPhase("evaluating");
    setIsBusy(true);
    try {
      const response = await fetch(`/api/study-sessions/${session.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionQuestionId: sessionQuestion.id, answerText, confidence: confidence ?? undefined }),
      });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not save this answer.");

      setSession(body.session);
      const answer = body.answer as AnswerDTO;
      setSessionQuestion({ ...sessionQuestion, answeredAt: new Date().toISOString(), answer });

      if (answer.evaluationStatus === "COMPLETED") {
        setPhase("rating");
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
        answeredAt: new Date().toISOString(),
        answer: {
          id: "",
          score: 0,
          correctness: "FAILURE",
          feedback: "You revealed the answer instead of attempting retrieval.",
          correctAnswer: body.correctAnswer,
          revealedAnswer: true,
          evaluationStatus: "COMPLETED",
        },
      });
      setPhase("rating");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reveal the answer.");
    } finally {
      setIsBusy(false);
    }
  }

  async function rate(outcome: ReviewOutcomeValue) {
    if (!session || !sessionQuestion) return;
    setError(null);
    setIsBusy(true);
    try {
      const response = await fetch(`/api/review-sessions/${session.id}/rate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionQuestionId: sessionQuestion.id, outcome }),
      });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not record your rating.");
      setRatingResult(body as RatingResultDTO);
      setPhase("rated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record your rating.");
    } finally {
      setIsBusy(false);
    }
  }

  async function goNext() {
    if (!session) return;
    setError(null);
    setIsBusy(true);
    try {
      const response = await fetch(`/api/review-sessions/${session.id}/next`, { method: "POST" });
      if (response.status === 409) {
        await finishSession();
        return;
      }
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not load the next review.");
      setSessionQuestion(body.sessionQuestion as SessionQuestionDTO);
      setAnswerText("");
      setConfidence(null);
      setRatingResult(null);
      setPhase("question");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the next review.");
    } finally {
      setIsBusy(false);
    }
  }

  async function finishSession() {
    if (!session) return;
    setIsBusy(true);
    try {
      const response = await fetch(`/api/review-sessions/${session.id}/complete`, { method: "POST" });
      const body = await parseJson(response);
      if (response.ok) setSummary(body);
      setPhase("summary");
    } finally {
      setIsBusy(false);
    }
  }

  if (phase === "checking") {
    return <LoadingState />;
  }

  if (phase === "fatal") {
    return (
      <div>
        <ErrorState message={error ?? "Something went wrong."} />
        <Link href={`/courses/${courseId}`} className="focus-ring mt-4 inline-block rounded text-sm text-fg-muted hover:underline">
          ← Back to course
        </Link>
      </div>
    );
  }

  if (phase === "idle") {
    return (
      <Card className="text-center">
        <h1 className="text-xl font-semibold text-fg">Review</h1>
        <p className="mt-2 text-sm text-fg-muted">Spaced review of what you&rsquo;ve already learned — {courseTitle}.</p>
        {dueState && (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <StatCard label="Due now" value={dueState.dueCount} />
            <StatCard label="Overdue" value={dueState.overdueCount} tone={dueState.overdueCount > 0 ? "warning" : "neutral"} />
          </div>
        )}
        {error && (
          <div className="mt-3">
            <InlineError message={error} />
          </div>
        )}
        <div className="mt-4">
          <Button variant="primary" size="lg" loading={isBusy} disabled={dueState != null && dueState.dueCount === 0} onClick={startSession}>
            {isBusy ? "Starting…" : "Start Review"}
          </Button>
        </div>
      </Card>
    );
  }

  if (phase === "nothing-due") {
    return (
      <Card className="text-center">
        <h1 className="text-xl font-semibold text-fg">Nothing due right now</h1>
        <p className="mt-2 text-sm text-fg-muted">Come back later — reviews are scheduled based on what you&rsquo;ve already learned.</p>
        <Link href={`/courses/${courseId}`} className="focus-ring mt-4 inline-block rounded text-sm text-fg-muted hover:underline">
          ← Back to course
        </Link>
      </Card>
    );
  }

  if (phase === "summary") {
    return <ReviewSummaryView summary={summary} courseId={courseId} />;
  }

  if (!session || !sessionQuestion) {
    return <LoadingState />;
  }

  return (
    <div>
      <div className="flex items-center justify-between text-sm text-fg-muted">
        <span>{courseTitle}</span>
        <span>
          Reviewed {session.questionsAnswered} / {session.targetLength}
        </span>
      </div>

      <Card className="animate-fade-in mt-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-fg">{sessionQuestion.question.concept.name}</h2>
          <Badge>Difficulty {sessionQuestion.question.difficulty}/5</Badge>
        </div>
        {sessionQuestion.reason && <p className="mt-1 text-xs text-fg-subtle">{sessionQuestion.reason}</p>}

        <p className="mt-4 text-lg leading-relaxed text-fg">{sessionQuestion.question.prompt}</p>

        {(phase === "question" || phase === "evaluating") && (
          <>
            <Textarea
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              disabled={phase === "evaluating"}
              rows={5}
              placeholder="Your answer, from memory…"
              className="mt-4"
            />

            {hint && (
              <div className="mt-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-fg">💡 {hint}</div>
            )}

            <div className="mt-3 flex items-center gap-2 text-sm text-fg-muted">
              <span>Confidence:</span>
              {[1, 2, 3, 4, 5].map((level) => (
                <button
                  key={level}
                  type="button"
                  aria-pressed={confidence === level}
                  disabled={phase === "evaluating"}
                  onClick={() => setConfidence(level)}
                  className={`focus-ring transition-standard h-7 w-7 rounded-full text-xs font-medium disabled:opacity-50 ${
                    confidence === level ? "bg-accent text-accent-fg" : "border border-border text-fg-muted hover:bg-surface-hover"
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>

            {error && (
              <div className="mt-3">
                <InlineError message={error} />
              </div>
            )}

            <div className="mt-4 flex items-center justify-between">
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={requestHint} disabled={isBusy || phase === "evaluating"}>
                  Hint
                </Button>
                <Button variant="ghost" size="sm" onClick={revealAnswer} disabled={isBusy || phase === "evaluating"}>
                  I don&rsquo;t know
                </Button>
              </div>
              <Button variant="primary" loading={phase === "evaluating"} onClick={submitAnswer} disabled={answerText.trim().length === 0}>
                {phase === "evaluating" ? "Evaluating…" : "Submit"}
              </Button>
            </div>
          </>
        )}

        {(phase === "eval_timeout" || phase === "eval_error") && (
          <div className="mt-4 border-t border-border pt-4">
            <div className="rounded-md border border-warning-border bg-warning-bg p-3 text-sm">
              <p className="font-medium text-warning-fg">
                {phase === "eval_timeout" ? "We couldn't evaluate your answer in time." : "We couldn't evaluate your answer right now."}
              </p>
              <p className="mt-1 text-warning-fg/90">Your answer has been saved. Rating needs it to finish evaluating.</p>
            </div>
            <div className="mt-4 flex justify-end">
              <Button
                variant="primary"
                loading={isBusy}
                onClick={() => {
                  setPhase("evaluating");
                  void runEvaluation(session.id, sessionQuestion.id);
                }}
              >
                Retry evaluation
              </Button>
            </div>
          </div>
        )}

        {phase === "rating" && sessionQuestion.answer && (
          <RatingView
            answer={sessionQuestion.answer}
            conceptId={sessionQuestion.question.conceptId}
            courseId={courseId}
            isBusy={isBusy}
            error={error}
            onRate={rate}
          />
        )}

        {phase === "rated" && ratingResult && (
          <div className="mt-4 border-t border-border pt-4">
            <p className="text-sm text-fg">
              Next review: <span className="font-medium">{formatNextReview(ratingResult.reviewItem.nextReviewAt)}</span>
            </p>
            <div className="mt-4 flex justify-end">
              <Button variant="primary" loading={isBusy} onClick={goNext}>
                {session.questionsAnswered >= session.targetLength ? "Finish Session" : "Continue"}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function scoreLabel(score: number | null): string {
  if (score == null) return "—";
  return `${Math.round(score * 100)}%`;
}

const OUTCOME_BUTTON_CLASSES: Record<ReviewOutcomeValue, string> = {
  AGAIN: "border-danger-border text-danger hover:bg-danger-bg",
  HARD: "border-warning-border text-warning hover:bg-warning-bg",
  GOOD: "border-success-border text-success hover:bg-success-bg",
  EASY: "border-info-border text-info hover:bg-info-bg",
};

const OUTCOME_LABEL: Record<ReviewOutcomeValue, string> = { AGAIN: "Again", HARD: "Hard", GOOD: "Good", EASY: "Easy" };

function RatingView({
  answer,
  conceptId,
  courseId,
  isBusy,
  error,
  onRate,
}: {
  answer: AnswerDTO;
  conceptId: string;
  courseId: string;
  isBusy: boolean;
  error: string | null;
  onRate: (outcome: ReviewOutcomeValue) => void;
}) {
  const failed = answer.correctness !== "SUCCESS";

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-2">
        {answer.correctness && <Badge tone={CORRECTNESS_TONE[answer.correctness]}>{answer.correctness === "SUCCESS" ? "Correct" : answer.correctness === "PARTIAL" ? "Partially correct" : "Needs review"}</Badge>}
        <p className="text-lg font-semibold text-fg">Score: {scoreLabel(answer.score)}</p>
      </div>
      {answer.feedback && <p className="mt-2 text-sm text-fg">{answer.feedback}</p>}
      {answer.correctAnswer && (
        <div className="mt-3">
          <p className="text-sm font-medium text-fg-muted">Explanation</p>
          <p className="mt-1 text-sm text-fg">{answer.correctAnswer}</p>
        </div>
      )}

      {failed && (
        <Link
          href={`/courses/${courseId}/tutor?conceptId=${conceptId}&mode=REMEDIATION`}
          className="focus-ring mt-3 inline-block rounded text-sm text-fg-muted underline-offset-2 hover:underline"
        >
          Struggling with this? Work through it with the AI Tutor →
        </Link>
      )}

      {error && (
        <div className="mt-3">
          <InlineError message={error} />
        </div>
      )}

      <p className="mt-4 text-sm font-medium text-fg">How well did you recall this?</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {(["AGAIN", "HARD", "GOOD", "EASY"] as const).map((outcome) => (
          <button
            key={outcome}
            type="button"
            disabled={isBusy}
            onClick={() => onRate(outcome)}
            className={`focus-ring transition-standard rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-50 ${OUTCOME_BUTTON_CLASSES[outcome]}`}
          >
            {OUTCOME_LABEL[outcome]}
          </button>
        ))}
      </div>
    </div>
  );
}

function ReviewSummaryView({ summary, courseId }: { summary: ReviewSummaryDTO | null; courseId: string }) {
  return (
    <Card>
      <h1 className="text-xl font-semibold text-fg">Review Complete</h1>
      {summary ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <StatCard label="Reviewed" value={summary.reviewed} />
            <StatCard label="Again" value={summary.again} tone={summary.again > 0 ? "danger" : "neutral"} />
            <StatCard label="Hard" value={summary.hard} tone={summary.hard > 0 ? "warning" : "neutral"} />
            <StatCard label="Good" value={summary.good} tone={summary.good > 0 ? "success" : "neutral"} />
            <StatCard label="Easy" value={summary.easy} tone={summary.easy > 0 ? "success" : "neutral"} />
          </div>
          <p className="mt-6 text-sm text-fg-muted">
            Next review: <span className="font-medium text-fg">{formatNextReview(summary.nextReviewAt)}</span>
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-fg-muted">Summary unavailable.</p>
      )}

      <div className="mt-6 flex gap-3">
        <Link href={`/courses/${courseId}/review`}>
          <Button variant="primary">Back to reviews</Button>
        </Link>
        <Link href={`/courses/${courseId}`}>
          <Button variant="secondary">Back to course</Button>
        </Link>
      </div>
    </Card>
  );
}
