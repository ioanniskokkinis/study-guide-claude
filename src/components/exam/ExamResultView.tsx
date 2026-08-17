"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { InlineError } from "@/components/ui/ErrorState";

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

function scoreTone(score: number): "success" | "warning" | "danger" {
  if (score >= 0.75) return "success";
  if (score >= 0.5) return "warning";
  return "danger";
}

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
    <div className="mt-6 space-y-6">
      <Card className="text-center">
        <p className="text-4xl font-semibold text-fg">{Math.round(result.percentage * 100)}%</p>
        <div className="mt-1">
          <Badge tone={result.passed ? "success" : "danger"}>{result.passed ? "Passed" : "Not passed"}</Badge>
        </div>
        <p className="mt-3 text-sm text-fg-muted">
          {result.correctAnswers} correct · {result.partialAnswers} partial · {result.incorrectAnswers} incorrect · {result.unanswered} unanswered ·{" "}
          {formatMinutes(result.timeSpentSeconds)}
        </p>
      </Card>

      <Card>
        <h2 className="text-xs font-medium tracking-wide text-fg-muted uppercase">Concept Scores</h2>
        <ul className="mt-3 space-y-2.5">
          {Object.entries(result.conceptScores)
            .sort((a, b) => a[1].score - b[1].score)
            .map(([id, c]) => (
              <li key={id} className="flex items-center gap-3 text-sm">
                <span className="w-32 shrink-0 truncate text-fg">{c.name}</span>
                <ProgressBar value={c.score} tone={scoreTone(c.score)} className="flex-1" />
                <span className="w-10 shrink-0 text-right text-fg-muted">{Math.round(c.score * 100)}%</span>
              </li>
            ))}
        </ul>
      </Card>

      <Card>
        <h2 className="text-xs font-medium tracking-wide text-fg-muted uppercase">Cognitive Scores</h2>
        <ul className="mt-3 space-y-2">
          {Object.entries(result.cognitiveScores)
            .filter(([, score]) => score > 0)
            .map(([level, score]) => (
              <li key={level} className="flex items-center justify-between text-sm">
                <span className="text-fg">{level}</span>
                <span className="text-fg-muted">{Math.round(score * 100)}%</span>
              </li>
            ))}
        </ul>
      </Card>

      <Card>
        <h2 className="text-xs font-medium tracking-wide text-fg-muted uppercase">Recommended Next Step</h2>
        <p className="mt-2 text-sm text-fg">{result.nextAction.reason}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button variant="primary" loading={retesting} onClick={() => void startRetest()}>
            {retesting ? "Preparing…" : "Retest Weak Areas"}
          </Button>
          <a href={`/courses/${courseId}/tutor`}>
            <Button variant="secondary">Study with the Tutor</Button>
          </a>
        </div>
        {error && (
          <div className="mt-3">
            <InlineError message={error} />
          </div>
        )}
      </Card>

      {incorrectQuestions.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-fg-muted">Review</h2>
          <ul className="mt-2 space-y-3">
            {incorrectQuestions.map((q) => (
              <li key={q.questionId}>
                <Card padding="sm">
                  <p className="text-xs font-medium text-fg-subtle uppercase">
                    {q.conceptName} · {q.classification ? CLASSIFICATION_LABEL[q.classification] : ""}
                  </p>
                  <p className="mt-1 text-sm text-fg">{q.prompt}</p>
                  {q.feedback && <p className="mt-2 text-sm text-fg-muted">{q.feedback}</p>}
                  {q.missingConcepts.length > 0 && <p className="mt-1 text-sm text-fg-muted">Missing: {q.missingConcepts.join(", ")}</p>}
                  {q.expectedAnswer && (
                    <p className="mt-2 text-sm text-fg-muted">
                      <span className="font-medium text-fg">Reference:</span> {q.expectedAnswer}
                    </p>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
