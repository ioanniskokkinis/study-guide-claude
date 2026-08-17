"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { DEFAULT_PASSING_SCORE, DEFAULT_QUESTION_COUNT } from "@/lib/exam/config";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { InlineError } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/Skeleton";

interface Turn {
  id: string;
  role: "EXAMINER" | "STUDENT";
  content: string;
}

type LoadState =
  | { status: "starting" }
  | { status: "active"; examId: string; questionId: string; turns: Turn[] }
  | { status: "complete"; examId: string; turns: Turn[] }
  | { status: "error"; message: string };

async function parseJson(response: Response) {
  return response.json().catch(() => ({}));
}

/**
 * Simple examiner-style interface (spec §67-68) — text input only, since
 * no speech-to-text provider is already wired into this project. One
 * examiner question at a time, no explanations given during the exam
 * (spec §14, §29).
 */
export function OralExamRunner({ courseId }: { courseId: string }) {
  const router = useRouter();
  const [load, setLoad] = useState<LoadState>({ status: "starting" });
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  async function begin() {
    try {
      const createResponse = await fetch(`/api/courses/${courseId}/exams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "ORAL",
          questionCount: DEFAULT_QUESTION_COUNT,
          durationMinutes: 20,
          difficulty: 2,
          allowHints: false,
          allowSources: false,
          passingScore: DEFAULT_PASSING_SCORE,
        }),
      });
      const createBody = await parseJson(createResponse);
      if (!createResponse.ok) throw new Error(createBody.error ?? "Could not start the oral exam.");
      const examId = createBody.exam.id as string;

      const startResponse = await fetch(`/api/exams/${examId}/start`, { method: "POST" });
      const startBody = await parseJson(startResponse);
      if (!startResponse.ok) throw new Error(startBody.error ?? "Could not start the oral exam.");

      if (!startBody.question) {
        setLoad({ status: "complete", examId, turns: [] });
        return;
      }
      setLoad({
        status: "active",
        examId,
        questionId: startBody.question.id,
        turns: [{ id: startBody.question.id, role: "EXAMINER", content: startBody.question.prompt }],
      });
    } catch (err) {
      setLoad({ status: "error", message: err instanceof Error ? err.message : "Could not start the oral exam." });
    }
  }

  useEffect(() => {
    // One-time exam creation + start on mount — not a subscription to an external system.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  async function respond() {
    if (load.status !== "active" || input.trim().length === 0) return;
    const answerText = input.trim();
    setSending(true);
    const studentTurn: Turn = { id: `student-${Date.now()}`, role: "STUDENT", content: answerText };
    setLoad({ ...load, turns: [...load.turns, studentTurn] });
    setInput("");

    try {
      const response = await fetch(`/api/exams/${load.examId}/answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: load.questionId, answerText }),
      });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not submit your answer.");

      if (body.examComplete || !body.nextQuestion) {
        setLoad({ status: "complete", examId: load.examId, turns: [...load.turns, studentTurn] });
      } else {
        setLoad({
          status: "active",
          examId: load.examId,
          questionId: body.nextQuestion.id,
          turns: [...load.turns, studentTurn, { id: body.nextQuestion.id, role: "EXAMINER", content: body.nextQuestion.prompt }],
        });
      }
    } catch (err) {
      setLoad({ status: "error", message: err instanceof Error ? err.message : "Could not submit your answer." });
    } finally {
      setSending(false);
    }
  }

  async function finish(examId: string) {
    setSending(true);
    try {
      const response = await fetch(`/api/exams/${examId}/submit`, { method: "POST" });
      const body = await parseJson(response);
      if (!response.ok) throw new Error(body.error ?? "Could not submit the exam.");
      router.push(`/courses/${courseId}/exam/${examId}/result`);
    } catch (err) {
      setLoad({ status: "error", message: err instanceof Error ? err.message : "Could not submit the exam." });
      setSending(false);
    }
  }

  if (load.status === "starting") {
    return <LoadingState label="The examiner is getting ready" />;
  }
  if (load.status === "error") {
    return (
      <div>
        <InlineError message={load.message} />
        <Link href={`/courses/${courseId}/exam`} className="focus-ring mt-4 inline-block rounded text-sm text-fg-muted hover:underline">
          ← Back to exams
        </Link>
      </div>
    );
  }

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="max-h-96 space-y-3 overflow-y-auto px-4 py-4">
        {load.turns.map((t) => (
          <div key={t.id} className={t.role === "STUDENT" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                t.role === "STUDENT"
                  ? "max-w-[80%] rounded-lg bg-accent px-3 py-2 text-sm whitespace-pre-wrap text-accent-fg"
                  : "max-w-[80%] rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm whitespace-pre-wrap text-fg"
              }
            >
              {t.content}
            </div>
          </div>
        ))}
      </div>

      {load.status === "active" ? (
        <div className="border-t border-border px-4 py-4">
          <div className="flex gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void respond();
                }
              }}
              disabled={sending}
              rows={2}
              placeholder="Your answer…"
              className="flex-1 resize-none"
            />
            <Button variant="primary" className="self-end" onClick={() => void respond()} disabled={sending || input.trim().length === 0}>
              Send
            </Button>
          </div>
        </div>
      ) : (
        <div className="border-t border-border px-4 py-4 text-center">
          <p className="mb-3 text-sm text-fg-muted">The oral exam is complete.</p>
          <Button variant="primary" loading={sending} onClick={() => void finish(load.examId)}>
            {sending ? "Submitting…" : "Submit Exam"}
          </Button>
        </div>
      )}
    </Card>
  );
}
