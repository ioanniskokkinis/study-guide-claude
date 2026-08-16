"use client";

import { useEffect, useRef, useState } from "react";

interface DisplayMessage {
  id: string;
  role: "TUTOR" | "STUDENT" | "SYSTEM";
  content: string;
}

interface SessionInfo {
  id: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "ABANDONED";
  mode: "SOCRATIC" | "TEACH_BACK" | "REMEDIATION";
  difficulty: number;
  questionsAnswered: number;
  hintLevel: number;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; session: SessionInfo; messages: DisplayMessage[] }
  | { status: "error"; message: string };

interface RawMessage {
  id: string;
  role: "TUTOR" | "STUDENT" | "SYSTEM";
  content: string;
}

interface RawSession {
  id: string;
  status: SessionInfo["status"];
  mode: SessionInfo["mode"];
  difficulty: number;
  questionsAnswered: number;
  hintLevel: number;
}

/** Mirrors the server's TutorStreamEvent union (src/lib/tutor/tutor-orchestrator.ts) — kept independent since routes in this codebase are always consumed as plain JSON, never through a shared client/server type. */
type StreamEvent =
  | { type: "start"; sessionId: string; action: string; aiGenerated: boolean }
  | { type: "delta"; text: string }
  | { type: "metadata"; latency: unknown }
  | { type: "complete"; session: RawSession; message: RawMessage }
  | { type: "error"; message: string };

function toDisplayMessage(m: RawMessage): DisplayMessage {
  return { id: m.id, role: m.role, content: m.content };
}

function toSessionInfo(s: RawSession): SessionInfo {
  return {
    id: s.id,
    status: s.status,
    mode: s.mode,
    difficulty: s.difficulty,
    questionsAnswered: s.questionsAnswered,
    hintLevel: s.hintLevel,
  };
}

async function parseJson(response: Response) {
  return response.json().catch(() => ({}));
}

const MODE_LABEL: Record<SessionInfo["mode"], string> = {
  SOCRATIC: "Socratic",
  TEACH_BACK: "Teach-back",
  REMEDIATION: "Remediation",
};

/** Parses complete `data: ...\n\n` SSE frames out of a growing buffer, returning the leftover partial buffer. */
function extractSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;
  let boundary = rest.indexOf("\n\n");
  while (boundary !== -1) {
    frames.push(rest.slice(0, boundary));
    rest = rest.slice(boundary + 2);
    boundary = rest.indexOf("\n\n");
  }
  return { frames, rest };
}

export function TutorChat({
  courseId,
  conceptId,
  conceptName,
  initialMastery,
  mode,
}: {
  courseId: string;
  conceptId: string;
  conceptName: string;
  initialMastery: number;
  mode: SessionInfo["mode"];
}) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [input, setInput] = useState("");
  const [confidence, setConfidence] = useState<"CONFIDENT" | "UNSURE" | "GUESSING" | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** null = no active generation; "" or partial text = the streaming Tutor placeholder's accumulated text so far. */
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<{ text: string; confidence: "CONFIDENT" | "UNSURE" | "GUESSING" | null } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  async function loadSession() {
    const next = await fetch("/api/tutor/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courseId, conceptId, mode }),
    })
      .then(async (response) => {
        const body = await parseJson(response);
        if (!response.ok) throw new Error(body.error ?? "Could not start the tutoring session.");
        return {
          status: "ready",
          session: toSessionInfo(body.session as RawSession),
          messages: (body.messages as RawMessage[]).map(toDisplayMessage),
        } as const;
      })
      .catch((err) => ({ status: "error", message: err instanceof Error ? err.message : "Could not start the session." }) as const);
    setLoad(next);
  }

  useEffect(() => {
    // One-time session start/resume on mount — not a subscription to an
    // external system, so the "cascading renders" concern the lint rule
    // guards against doesn't apply here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, conceptId, mode]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [load, streamingText]);

  async function postAction(url: string, body?: Record<string, unknown>) {
    if (load.status !== "ready") return;
    setSending(true);
    setSendError(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const parsed = await parseJson(response);
      if (!response.ok) throw new Error(parsed.error ?? "Something went wrong.");
      const newMessage = toDisplayMessage(parsed.message as RawMessage);
      const newSession = toSessionInfo(parsed.session as RawSession);
      setLoad({ status: "ready", session: newSession, messages: [...load.messages, newMessage] });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  /** Streams a chat turn via SSE (Phase 11): the Tutor placeholder appears immediately and fills in as `delta` events arrive; `complete` swaps it for the real persisted message. */
  async function streamTurn(sessionId: string, text: string, confidenceValue: typeof confidence) {
    setSending(true);
    setSendError(null);
    setStreamingText("");

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch(`/api/tutor/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, confidence: confidenceValue }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const parsed = await parseJson(response);
        throw new Error(parsed.error ?? "Something went wrong.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      while (!done) {
        const chunk = await reader.read();
        done = chunk.done;
        if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });

        const { frames, rest } = extractSseFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let event: StreamEvent;
          try {
            event = JSON.parse(line.slice("data: ".length));
          } catch {
            continue;
          }

          if (event.type === "delta") {
            setStreamingText((prev) => (prev ?? "") + event.text);
          } else if (event.type === "complete") {
            const newMessage = toDisplayMessage(event.message);
            const newSession = toSessionInfo(event.session);
            setLoad((prev) => (prev.status === "ready" ? { status: "ready", session: newSession, messages: [...prev.messages, newMessage] } : prev));
          } else if (event.type === "error") {
            setSendError(event.message);
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setSendError(err instanceof Error ? err.message : "Something went wrong.");
      }
      // Aborted (user hit Stop) — not an error; the placeholder is simply cleared in `finally` below.
    } finally {
      setStreamingText(null);
      setSending(false);
      abortControllerRef.current = null;
    }
  }

  async function send(text: string) {
    if (load.status !== "ready" || text.trim().length === 0 || sending) return;
    const trimmed = text.trim();
    const optimistic: DisplayMessage = { id: `pending-${Date.now()}`, role: "STUDENT", content: trimmed };
    setLoad({ status: "ready", session: load.session, messages: [...load.messages, optimistic] });
    setInput("");
    const usedConfidence = confidence;
    setConfidence(null);
    setLastSent({ text: trimmed, confidence: usedConfidence });
    await streamTurn(load.session.id, trimmed, usedConfidence);
  }

  function retry() {
    if (!lastSent) return;
    void send(lastSent.text);
  }

  function cancelGeneration() {
    abortControllerRef.current?.abort();
  }

  if (load.status === "loading") {
    return <p className="text-sm text-zinc-500">Starting the tutor…</p>;
  }

  if (load.status === "error") {
    return <p className="text-sm text-red-600 dark:text-red-400">{load.message}</p>;
  }

  const { session, messages } = load;
  const isComplete = session.status === "COMPLETED";

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div>
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">Topic: {conceptName}</p>
          <p className="text-xs text-zinc-500">
            {MODE_LABEL[session.mode]} · Mastery: {Math.round(initialMastery * 100)}% · Difficulty {session.difficulty}/5
          </p>
        </div>
        {isComplete && (
          <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
            Complete
          </span>
        )}
      </div>

      <div className="max-h-96 space-y-3 overflow-y-auto px-4 py-4">
        {messages.map((m) => (
          <div key={m.id} className={m.role === "STUDENT" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                m.role === "STUDENT"
                  ? "max-w-[80%] rounded-lg bg-zinc-900 px-3 py-2 text-sm whitespace-pre-wrap text-white dark:bg-zinc-50 dark:text-zinc-900"
                  : "max-w-[80%] rounded-lg bg-zinc-100 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
              }
            >
              {m.content}
            </div>
          </div>
        ))}
        {streamingText !== null && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-lg bg-zinc-100 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
              {streamingText}
              <span className="animate-pulse">▌</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {sendError && (
        <div className="flex items-center gap-3 px-4">
          <p className="text-sm text-red-600 dark:text-red-400">{sendError}</p>
          {lastSent && (
            <button
              type="button"
              onClick={retry}
              disabled={sending}
              className="text-sm text-zinc-500 underline-offset-2 hover:underline disabled:opacity-50"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {isComplete ? (
        <div className="border-t border-zinc-200 px-4 py-4 text-sm text-zinc-500 dark:border-zinc-800">
          You&rsquo;ve shown solid, independent understanding of {conceptName}. This conversation is finished.
        </div>
      ) : (
        <div className="border-t border-zinc-200 px-4 py-4 dark:border-zinc-800">
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              disabled={sending}
              rows={2}
              placeholder="Type your answer…"
              className="flex-1 resize-none rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950"
            />
            {sending ? (
              <button
                type="button"
                onClick={cancelGeneration}
                className="self-end rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send(input)}
                disabled={input.trim().length === 0}
                className="self-end rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Send
              </button>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-400">How sure are you?</span>
            {(["CONFIDENT", "UNSURE", "GUESSING"] as const).map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setConfidence((c) => (c === level ? null : level))}
                disabled={sending}
                className={
                  confidence === level
                    ? "rounded-full bg-zinc-900 px-2.5 py-1 text-xs text-white dark:bg-zinc-50 dark:text-zinc-900"
                    : "rounded-full border border-zinc-300 px-2.5 py-1 text-xs text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                }
              >
                {level === "CONFIDENT" ? "Confident" : level === "UNSURE" ? "Unsure" : "Guessing"}
              </button>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            <button
              type="button"
              onClick={() => void postAction(`/api/tutor/sessions/${session.id}/hint`)}
              disabled={sending}
              className="text-zinc-500 underline-offset-2 hover:underline disabled:opacity-50"
            >
              Hint
            </button>
            <button
              type="button"
              onClick={() => void send("I don't know")}
              disabled={sending}
              className="text-zinc-500 underline-offset-2 hover:underline disabled:opacity-50"
            >
              I don&rsquo;t know
            </button>
            <button
              type="button"
              onClick={() => void send("Just tell me")}
              disabled={sending}
              className="text-zinc-500 underline-offset-2 hover:underline disabled:opacity-50"
            >
              Just tell me
            </button>
            {session.mode !== "TEACH_BACK" && (
              <button
                type="button"
                onClick={() => void postAction(`/api/tutor/sessions/${session.id}/teach-back`)}
                disabled={sending}
                className="text-zinc-500 underline-offset-2 hover:underline disabled:opacity-50"
              >
                Explain it back to me
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
