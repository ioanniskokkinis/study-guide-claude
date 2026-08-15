"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatRelativeDays } from "@/lib/format";

type Correctness = "SUCCESS" | "PARTIAL" | "FAILURE";
type ReviewOutcomeValue = "AGAIN" | "HARD" | "GOOD" | "EASY";

interface QuestionDTO {
  id: string;
  conceptId: string;
  difficulty: number;
  prompt: string;
}

interface AnswerDTO {
  id: string;
  score: number | null;
  correctness: Correctness | null;
  feedback: string | null;
  correctAnswer: string | null;
  revealedAnswer: boolean;
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

type Phase = "checking" | "idle" | "nothing-due" | "question" | "evaluating" | "feedback" | "rating" | "rated" | "summary" | "fatal";

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
    if (state.currentSessionQuestion?.answeredAt != null && state.currentSessionQuestion?.answer) {
      setPhase("rating");
    } else {
      setPhase("question");
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
      if (!response.ok) throw new Error(body.error ?? "Could not evaluate this answer.");

      setSession(body.session);
      setSessionQuestion({ ...sessionQuestion, answeredAt: new Date().toISOString(), answer: body.answer as AnswerDTO });
      setPhase("rating");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not evaluate this answer.");
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
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Review</h1>
        <p className="mt-2 text-sm text-zinc-500">Spaced review of what you&rsquo;ve already learned — {courseTitle}.</p>
        {dueState && (
          <dl className="mt-4 grid grid-cols-2 gap-4 text-center">
            <div>
              <dt className="text-xs text-zinc-400">Due now</dt>
              <dd className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{dueState.dueCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400">Overdue</dt>
              <dd className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{dueState.overdueCount}</dd>
            </div>
          </dl>
        )}
        {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <button
          type="button"
          onClick={startSession}
          disabled={isBusy || (dueState != null && dueState.dueCount === 0)}
          className="mt-4 rounded-md bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {isBusy ? "Starting…" : "Start Review"}
        </button>
      </div>
    );
  }

  if (phase === "nothing-due") {
    return (
      <div className="rounded-lg border border-zinc-200 p-6 text-center dark:border-zinc-800">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Nothing due right now</h1>
        <p className="mt-2 text-sm text-zinc-500">Come back later — reviews are scheduled based on what you&rsquo;ve already learned.</p>
        <Link href={`/courses/${courseId}`} className="mt-4 inline-block text-sm text-zinc-500 hover:underline">
          ← Back to course
        </Link>
      </div>
    );
  }

  if (phase === "summary") {
    return <ReviewSummaryView summary={summary} courseId={courseId} />;
  }

  if (!session || !sessionQuestion) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between text-sm text-zinc-500">
        <span>{courseTitle}</span>
        <span>
          Reviewed {session.questionsAnswered} / {session.targetLength}
        </span>
      </div>

      <div className="mt-4 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{sessionQuestion.question.concept.name}</h2>
          <span className="text-xs text-zinc-400">Difficulty: {sessionQuestion.question.difficulty}/5</span>
        </div>
        {sessionQuestion.reason && <p className="mt-1 text-xs text-zinc-400">{sessionQuestion.reason}</p>}

        <p className="mt-4 text-zinc-800 dark:text-zinc-200">{sessionQuestion.question.prompt}</p>

        {(phase === "question" || phase === "evaluating") && (
          <>
            <textarea
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              disabled={phase === "evaluating"}
              rows={5}
              placeholder="Your answer, from memory…"
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
                  disabled={phase === "evaluating"}
                  onClick={() => setConfidence(level)}
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
                  disabled={isBusy || phase === "evaluating"}
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  Hint
                </button>
                <button
                  type="button"
                  onClick={revealAnswer}
                  disabled={isBusy || phase === "evaluating"}
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  I don&rsquo;t know
                </button>
              </div>
              <button
                type="button"
                onClick={submitAnswer}
                disabled={phase === "evaluating" || answerText.trim().length === 0}
                className="rounded-md bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {phase === "evaluating" ? "Evaluating…" : "Submit"}
              </button>
            </div>
          </>
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
          <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              Next review: <span className="font-medium">{formatNextReview(ratingResult.reviewItem.nextReviewAt)}</span>
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={goNext}
                disabled={isBusy}
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {session.questionsAnswered >= session.targetLength ? "Finish Session" : "Continue"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function scoreLabel(score: number | null): string {
  if (score == null) return "—";
  return `${Math.round(score * 100)}%`;
}

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
    <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Score: {scoreLabel(answer.score)}</p>
      {answer.feedback && <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">{answer.feedback}</p>}
      {answer.correctAnswer && (
        <div className="mt-3">
          <p className="text-sm font-medium text-zinc-500">Explanation</p>
          <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{answer.correctAnswer}</p>
        </div>
      )}

      {failed && (
        <Link
          href={`/courses/${courseId}/tutor?conceptId=${conceptId}&mode=REMEDIATION`}
          className="mt-3 inline-block text-sm text-zinc-500 underline-offset-2 hover:underline"
        >
          Struggling with this? Work through it with the AI Tutor →
        </Link>
      )}

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <p className="mt-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">How well did you recall this?</p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={isBusy}
          onClick={() => onRate("AGAIN")}
          className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
        >
          Again
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => onRate("HARD")}
          className="rounded-md border border-amber-300 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-900 dark:text-amber-400 dark:hover:bg-amber-950/30"
        >
          Hard
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => onRate("GOOD")}
          className="rounded-md border border-emerald-300 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-900 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
        >
          Good
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => onRate("EASY")}
          className="rounded-md border border-sky-300 px-4 py-2 text-sm font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-50 dark:border-sky-900 dark:text-sky-400 dark:hover:bg-sky-950/30"
        >
          Easy
        </button>
      </div>
    </div>
  );
}

function ReviewSummaryView({ summary, courseId }: { summary: ReviewSummaryDTO | null; courseId: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Review Complete</h1>
      {summary ? (
        <>
          <dl className="mt-4 grid grid-cols-5 gap-3 text-center">
            <div>
              <dt className="text-xs text-zinc-400">Reviewed</dt>
              <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{summary.reviewed}</dd>
            </div>
            <div>
              <dt className="text-xs text-red-500">Again</dt>
              <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{summary.again}</dd>
            </div>
            <div>
              <dt className="text-xs text-amber-500">Hard</dt>
              <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{summary.hard}</dd>
            </div>
            <div>
              <dt className="text-xs text-emerald-500">Good</dt>
              <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{summary.good}</dd>
            </div>
            <div>
              <dt className="text-xs text-sky-500">Easy</dt>
              <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{summary.easy}</dd>
            </div>
          </dl>
          <p className="mt-6 text-sm text-zinc-500">
            Next review: <span className="font-medium text-zinc-700 dark:text-zinc-300">{formatNextReview(summary.nextReviewAt)}</span>
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-zinc-500">Summary unavailable.</p>
      )}

      <div className="mt-6 flex gap-3">
        <Link
          href={`/courses/${courseId}/review`}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Back to reviews
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
