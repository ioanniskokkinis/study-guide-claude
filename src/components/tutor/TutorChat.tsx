"use client";

import { memo, useEffect, useRef, useState } from "react";
import { renderSafeMarkdown } from "@/lib/markdown/safe-markdown";
import { consumeTutorStream, type RawTutorMessage, type RawTutorSession } from "@/lib/tutor/client-stream";

interface DisplayMessage {
  id: string;
  role: "TUTOR" | "STUDENT" | "SYSTEM";
  content: string;
  messageType?: string;
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

/** The Phase 13 §8 streaming state machine — every streaming call site (session start, message, hint) drives the same five states. */
type StreamPhase = "idle" | "connecting" | "streaming" | "complete" | "error" | "cancelled";

type StreamingKind = "opening" | "message" | "hint" | null;

type LastAction = { kind: "message"; text: string; confidence: "CONFIDENT" | "UNSURE" | "GUESSING" | null } | { kind: "hint" } | null;

function toDisplayMessage(m: RawTutorMessage): DisplayMessage {
  return { id: m.id, role: m.role, content: m.content, messageType: m.messageType };
}

function toSessionInfo(s: RawTutorSession): SessionInfo {
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

const MESSAGE_TYPE_LABEL: Partial<Record<string, string>> = {
  HINT: "Hint",
};

/** One conversation bubble — memoized so a streaming placeholder's frequent re-renders never re-parse/re-render already-settled messages (Phase 13 §15). */
const MessageBubble = memo(function MessageBubble({ message }: { message: DisplayMessage }) {
  const label = message.messageType ? MESSAGE_TYPE_LABEL[message.messageType] : undefined;
  return (
    <div className={message.role === "STUDENT" ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          message.role === "STUDENT"
            ? "max-w-[80%] rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-zinc-50 dark:text-zinc-900"
            : "max-w-[80%] rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
        }
      >
        {label && <p className="mb-1 text-[10px] font-medium tracking-wide text-zinc-400 uppercase">{label}</p>}
        {message.role === "STUDENT" ? <p className="whitespace-pre-wrap">{message.content}</p> : renderSafeMarkdown(message.content)}
      </div>
    </div>
  );
});

/** The currently-streaming placeholder bubble — separate from `MessageBubble` since it re-renders on every delta by design. */
function StreamingBubble({ phase, kind, text }: { phase: StreamPhase; kind: StreamingKind; text: string | null }) {
  if (phase === "connecting") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-400 dark:bg-zinc-900 dark:text-zinc-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400" />
            Tutor is thinking…
          </span>
        </div>
      </div>
    );
  }

  if (phase === "streaming" && text !== null) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          {kind === "hint" && <p className="mb-1 text-[10px] font-medium tracking-wide text-zinc-400 uppercase">Hint</p>}
          {renderSafeMarkdown(text)}
          <span className="ml-0.5 inline-block w-2 animate-pulse text-zinc-400">▌</span>
        </div>
      </div>
    );
  }

  return null;
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
  const [streamPhase, setStreamPhase] = useState<StreamPhase>("idle");
  const [streamingKind, setStreamingKind] = useState<StreamingKind>(null);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<LastAction>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);
  /** Bumped on every new stream; a callback that finds it's no longer current knows a newer stream has superseded it and drops its update (Phase 13 §8 — guards stale/duplicate completion and one stream overwriting another). */
  const streamEpochRef = useRef(0);

  const sending = streamPhase === "connecting" || streamPhase === "streaming";

  function appendCompletedMessage(message: RawTutorMessage, session: RawTutorSession) {
    const newMessage = toDisplayMessage(message);
    const newSession = toSessionInfo(session);
    setLoad((prev) => {
      if (prev.status !== "ready") return prev;
      if (prev.messages.some((m) => m.id === newMessage.id)) return { ...prev, session: newSession };
      return { status: "ready", session: newSession, messages: [...prev.messages, newMessage] };
    });
  }

  /** Starts or resumes the session (spec §20). A resume is a plain JSON response (nothing to generate); a fresh start streams the opening question via the same protocol as every other Tutor generation (Phase 13 §3/§19). */
  async function loadSession() {
    setLoad({ status: "loading" });
    const epoch = ++streamEpochRef.current;

    try {
      const response = await fetch("/api/tutor/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId, conceptId, mode }),
      });

      const isStream = (response.headers.get("Content-Type") ?? "").includes("text/event-stream");
      if (!isStream) {
        const body = await parseJson(response);
        if (!response.ok) throw new Error(body.error ?? "Could not start the tutoring session.");
        setLoad({
          status: "ready",
          session: toSessionInfo(body.session as RawTutorSession),
          messages: (body.messages as RawTutorMessage[]).map(toDisplayMessage),
        });
        return;
      }

      setStreamingKind("opening");
      setStreamPhase("streaming");
      setStreamingText("");

      await consumeTutorStream(response, (event) => {
        if (streamEpochRef.current !== epoch) return;
        if (event.type === "start") {
          setLoad({
            status: "ready",
            session: { id: event.sessionId, status: "ACTIVE", mode, difficulty: 1, questionsAnswered: 0, hintLevel: 0 },
            messages: [],
          });
        } else if (event.type === "delta") {
          setStreamingText((prev) => (prev ?? "") + event.text);
        } else if (event.type === "complete") {
          setLoad({ status: "ready", session: toSessionInfo(event.session), messages: [toDisplayMessage(event.message)] });
          setStreamPhase("complete");
        } else if (event.type === "error") {
          setLoad({ status: "error", message: event.message });
          setStreamPhase("error");
        }
      });
    } catch (err) {
      if (streamEpochRef.current !== epoch) return;
      setLoad({ status: "error", message: err instanceof Error ? err.message : "Could not start the session." });
      setStreamPhase("error");
    } finally {
      if (streamEpochRef.current === epoch) {
        setStreamingText(null);
        setStreamingKind(null);
      }
    }
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
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [load, streamingText]);

  function handleScroll() {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 80;
  }

  async function postAction(url: string, body?: Record<string, unknown>) {
    if (load.status !== "ready") return;
    setStreamPhase("connecting");
    setSendError(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const parsed = await parseJson(response);
      if (!response.ok) throw new Error(parsed.error ?? "Something went wrong.");
      appendCompletedMessage(parsed.message as RawTutorMessage, parsed.session as RawTutorSession);
      setStreamPhase("complete");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Something went wrong.");
      setStreamPhase("error");
    }
  }

  /**
   * Drives one streaming Tutor turn — a normal message or a hint — through
   * the shared protocol (Phase 13 §4: "do not create a special hint
   * streaming implementation"). `fetchFn` is the only thing that differs
   * between them.
   */
  async function runTutorStream(fetchFn: (signal: AbortSignal) => Promise<Response>, kind: "message" | "hint") {
    if (load.status !== "ready") return;
    const epoch = ++streamEpochRef.current;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setStreamPhase("connecting");
    setSendError(null);
    setStreamingText("");
    setStreamingKind(kind);

    try {
      const response = await fetchFn(controller.signal);
      if (streamEpochRef.current !== epoch) return;

      if (!response.ok || !response.body) {
        const parsed = await parseJson(response);
        throw new Error(parsed.error ?? "Something went wrong.");
      }

      setStreamPhase("streaming");
      await consumeTutorStream(response, (event) => {
        if (streamEpochRef.current !== epoch) return;
        if (event.type === "delta") {
          setStreamingText((prev) => (prev ?? "") + event.text);
        } else if (event.type === "complete") {
          appendCompletedMessage(event.message, event.session);
          setStreamPhase("complete");
        } else if (event.type === "error") {
          setSendError(event.message);
          setStreamPhase("error");
        }
      });
    } catch (err) {
      if (streamEpochRef.current !== epoch) return;
      if (controller.signal.aborted) {
        setStreamPhase("cancelled");
      } else {
        setSendError(err instanceof Error ? err.message : "Something went wrong.");
        setStreamPhase("error");
      }
    } finally {
      if (streamEpochRef.current === epoch) {
        setStreamingText(null);
        setStreamingKind(null);
        abortControllerRef.current = null;
      }
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
    setLastAction({ kind: "message", text: trimmed, confidence: usedConfidence });
    const sessionId = load.session.id;
    await runTutorStream(
      (signal) =>
        fetch(`/api/tutor/sessions/${sessionId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: trimmed, confidence: usedConfidence }),
          signal,
        }),
      "message",
    );
  }

  async function requestHint() {
    if (load.status !== "ready" || sending) return;
    const sessionId = load.session.id;
    setLastAction({ kind: "hint" });
    await runTutorStream((signal) => fetch(`/api/tutor/sessions/${sessionId}/hint`, { method: "POST", signal }), "hint");
  }

  function retry() {
    if (!lastAction) return;
    if (lastAction.kind === "message") void send(lastAction.text);
    else void requestHint();
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

      <div ref={scrollContainerRef} onScroll={handleScroll} className="max-h-96 space-y-3 overflow-y-auto px-4 py-4">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        <StreamingBubble phase={streamPhase} kind={streamingKind} text={streamingText} />
        <div ref={messagesEndRef} />
      </div>

      {sendError && (
        <div className="flex items-center gap-3 px-4">
          <p className="text-sm text-red-600 dark:text-red-400">{sendError}</p>
          {lastAction && (
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
              onClick={() => void requestHint()}
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
