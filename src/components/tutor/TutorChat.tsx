"use client";

import { memo, useEffect, useRef, useState } from "react";
import { renderSafeMarkdown } from "@/lib/markdown/safe-markdown";
import { consumeTutorStream, type RawTutorMessage, type RawTutorSession } from "@/lib/tutor/client-stream";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Textarea } from "@/components/ui/Input";
import { InlineError } from "@/components/ui/ErrorState";

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

/** Phase 14 §8 — the audio playback state machine, one active message at a time across the whole chat. */
type AudioStatus = "idle" | "loading" | "playing" | "paused" | "error";

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
  REMEDIATION: "Remediation",
  TEACH_BACK_PROMPT: "Teach-back",
};

/**
 * Drives Play/Pause/Stop for Tutor message audio (Phase 14 §7-9, §13, §19).
 * A single `<audio>` element is shared across the whole chat so starting one
 * message's audio always stops any other (spec §8 — only one plays at a
 * time). Long responses are split server-side into parts (spec §13); on
 * `ended`, if more parts remain for the same message, the next part is
 * fetched and chained automatically so playback is seamless without ever
 * doing sentence-level live streaming (explicitly deferred, spec §14).
 */
function useTutorAudioPlayer(enabled: boolean) {
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const activeMessageIdRef = useRef<string | null>(null);
  const partRef = useRef(0);
  const totalPartsRef = useRef(1);
  const epochRef = useRef(0);

  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);
  const [status, setStatus] = useState<AudioStatus>("idle");

  async function fetchAndPlayPart(messageId: string, part: number, epoch: number) {
    try {
      const response = await fetch("/api/tutor/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, part }),
      });
      if (epochRef.current !== epoch) return;
      if (!response.ok) {
        setStatus("error");
        return;
      }
      totalPartsRef.current = Number(response.headers.get("X-Tts-Total-Parts") ?? "1") || 1;
      partRef.current = part;

      const blob = await response.blob();
      if (epochRef.current !== epoch) return;

      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;

      const audio = audioElRef.current;
      if (!audio) return;
      audio.src = url;
      await audio.play();
      if (epochRef.current !== epoch) return;
      setStatus("playing");
    } catch {
      if (epochRef.current !== epoch) return;
      setStatus("error");
    }
  }

  useEffect(() => {
    if (!enabled) return;
    const audio = new Audio();
    audioElRef.current = audio;

    function onEnded() {
      const messageId = activeMessageIdRef.current;
      if (!messageId) return;
      if (partRef.current + 1 < totalPartsRef.current) {
        void fetchAndPlayPart(messageId, partRef.current + 1, epochRef.current);
      } else {
        setStatus("idle");
        setPlayingMessageId(null);
        activeMessageIdRef.current = null;
      }
    }
    function onError() {
      setStatus("error");
    }
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    return () => {
      audio.pause();
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [enabled]);

  function play(messageId: string) {
    const epoch = ++epochRef.current;
    activeMessageIdRef.current = messageId;
    partRef.current = 0;
    totalPartsRef.current = 1;
    setPlayingMessageId(messageId);
    setStatus("loading");
    void fetchAndPlayPart(messageId, 0, epoch);
  }

  function pause() {
    audioElRef.current?.pause();
    setStatus("paused");
  }

  function resume() {
    void audioElRef.current?.play();
    setStatus("playing");
  }

  function stop() {
    epochRef.current++;
    audioElRef.current?.pause();
    if (audioElRef.current) audioElRef.current.currentTime = 0;
    activeMessageIdRef.current = null;
    setStatus("idle");
    setPlayingMessageId(null);
  }

  function toggle(messageId: string) {
    if (playingMessageId === messageId) {
      if (status === "playing") pause();
      else if (status === "paused") resume();
      else if (status === "error") play(messageId);
      // "loading" — a click is a no-op (button is disabled while loading).
    } else {
      play(messageId);
    }
  }

  return { playingMessageId, status, toggle, stop };
}

/** Accessible Play/Pause/Stop control for one Tutor message (Phase 14 §7-8, §17-18). State is always conveyed in the button's text, never by icon alone. */
function AudioControl({ status, onToggle, onStop }: { status: AudioStatus; onToggle: () => void; onStop: () => void }) {
  const isLoading = status === "loading";
  const isPlaying = status === "playing";
  const isPaused = status === "paused";
  const isError = status === "error";

  const label = isLoading
    ? "Loading Tutor response audio"
    : isPlaying
      ? "Pause Tutor response"
      : isPaused
        ? "Resume Tutor response"
        : isError
          ? "Retry Tutor response audio"
          : "Play Tutor response";
  const text = isLoading ? "Loading…" : isPlaying ? "⏸ Pause" : isPaused ? "▶ Resume" : isError ? "↻ Retry" : "▶ Listen";

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onToggle}
        disabled={isLoading}
        aria-label={label}
        className="focus-ring transition-standard inline-flex min-h-[32px] items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-fg-muted hover:bg-surface-hover disabled:opacity-50"
      >
        {text}
      </button>
      {(isPlaying || isPaused) && (
        <button type="button" onClick={onStop} aria-label="Stop Tutor response" className="focus-ring min-h-[32px] rounded px-1 text-xs text-fg-subtle underline-offset-2 hover:underline">
          Stop
        </button>
      )}
      {isError && <span className="text-xs text-danger">Couldn&rsquo;t play audio.</span>}
    </div>
  );
}

/** One conversation bubble — memoized so a streaming placeholder's frequent re-renders never re-parse/re-render already-settled messages (Phase 13 §15). */
const MessageBubble = memo(function MessageBubble({
  message,
  ttsEnabled,
  audioStatus,
  onToggleAudio,
  onStopAudio,
}: {
  message: DisplayMessage;
  ttsEnabled: boolean;
  audioStatus: AudioStatus;
  onToggleAudio: (messageId: string) => void;
  onStopAudio: () => void;
}) {
  const label = message.messageType ? MESSAGE_TYPE_LABEL[message.messageType] : undefined;
  const canListen = ttsEnabled && message.role === "TUTOR";
  const isStudent = message.role === "STUDENT";
  return (
    <div className={`flex ${isStudent ? "justify-end" : "justify-start"}`}>
      <div
        className={`animate-slide-up max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed sm:max-w-[80%] ${
          isStudent ? "bg-accent text-accent-fg" : "border border-border bg-surface-muted text-fg"
        }`}
      >
        {label && (
          <Badge tone={isStudent ? "neutral" : "info"} className={isStudent ? "mb-1.5 bg-accent-fg/15 text-accent-fg" : "mb-1.5"}>
            {label}
          </Badge>
        )}
        {isStudent ? <p className="whitespace-pre-wrap">{message.content}</p> : <div className="tutor-prose">{renderSafeMarkdown(message.content)}</div>}
        {canListen && <AudioControl status={audioStatus} onToggle={() => onToggleAudio(message.id)} onStop={onStopAudio} />}
      </div>
    </div>
  );
});

/** The currently-streaming placeholder bubble — separate from `MessageBubble` since it re-renders on every delta by design. */
function StreamingBubble({ phase, kind, text }: { phase: StreamPhase; kind: StreamingKind; text: string | null }) {
  if (phase === "connecting") {
    return (
      <div className="flex justify-start">
        <div role="status" className="rounded-lg border border-border bg-surface-muted px-3.5 py-2.5 text-sm text-fg-muted">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-subtle" />
            Tutor is thinking…
          </span>
        </div>
      </div>
    );
  }

  if (phase === "streaming" && text !== null) {
    return (
      <div className="flex justify-start">
        <div role="status" aria-live="polite" className="max-w-[85%] rounded-lg border border-border bg-surface-muted px-3.5 py-2.5 text-sm leading-relaxed text-fg sm:max-w-[80%]">
          {kind === "hint" && (
            <Badge tone="info" className="mb-1.5">
              Hint
            </Badge>
          )}
          <div className="tutor-prose">{renderSafeMarkdown(text)}</div>
          <span aria-hidden="true" className="ml-0.5 inline-block w-2 animate-pulse text-fg-subtle">
            ▌
          </span>
        </div>
      </div>
    );
  }

  return null;
}

const QUICK_ACTIONS: Array<{ label: string; text: string }> = [
  { label: "I don't know", text: "I don't know" },
  { label: "Just tell me", text: "Just tell me" },
  { label: "Explain differently", text: "Can you explain that differently?" },
  { label: "Give an example", text: "Can you give me an example?" },
  { label: "Test me", text: "Test me on this." },
];

export function TutorChat({
  courseId,
  conceptId,
  conceptName,
  initialMastery,
  mode,
  ttsEnabled = false,
}: {
  courseId: string;
  conceptId: string;
  conceptName: string;
  initialMastery: number;
  mode: SessionInfo["mode"];
  /** Phase 14 §3/§26 — when false (the default; TTS is opt-in server-side), no audio controls render and no TTS request is ever made. */
  ttsEnabled?: boolean;
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

  const audioPlayer = useTutorAudioPlayer(ttsEnabled);

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
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-fg-muted">
        <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        Starting the tutor…
      </p>
    );
  }

  if (load.status === "error") {
    return <InlineError message={load.message} />;
  }

  const { session, messages } = load;
  const isComplete = session.status === "COMPLETED";

  return (
    <div className="animate-fade-in flex h-[calc(100vh-13rem)] min-h-[28rem] flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-fg">{conceptName}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone="neutral">{MODE_LABEL[session.mode]}</Badge>
            <span className="text-xs text-fg-muted">Mastery {Math.round(initialMastery * 100)}%</span>
            <span className="text-xs text-fg-muted">· Difficulty {session.difficulty}/5</span>
          </div>
        </div>
        {isComplete && <Badge tone="success">Complete</Badge>}
      </div>

      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            ttsEnabled={ttsEnabled}
            audioStatus={audioPlayer.playingMessageId === m.id ? audioPlayer.status : "idle"}
            onToggleAudio={audioPlayer.toggle}
            onStopAudio={audioPlayer.stop}
          />
        ))}
        <StreamingBubble phase={streamPhase} kind={streamingKind} text={streamingText} />
        <div ref={messagesEndRef} />
      </div>

      {sendError && (
        <div className="flex items-center gap-3 border-t border-border px-4 py-2">
          <InlineError message={sendError} />
          {lastAction && (
            <Button variant="ghost" size="sm" disabled={sending} onClick={retry}>
              Retry
            </Button>
          )}
        </div>
      )}

      {isComplete ? (
        <div className="border-t border-border px-4 py-4 text-sm text-fg-muted">
          You&rsquo;ve shown solid, independent understanding of {conceptName}. This conversation is finished.
        </div>
      ) : (
        <div className="border-t border-border px-4 py-3.5">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Textarea
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
              aria-label="Your response to the tutor"
              className="flex-1"
            />
            {sending ? (
              <Button variant="secondary" onClick={cancelGeneration} className="sm:self-end">
                Stop
              </Button>
            ) : (
              <Button variant="primary" disabled={input.trim().length === 0} onClick={() => void send(input)} className="sm:self-end">
                Send
              </Button>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-fg-muted">How sure are you?</span>
            {(["CONFIDENT", "UNSURE", "GUESSING"] as const).map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setConfidence((c) => (c === level ? null : level))}
                disabled={sending}
                aria-pressed={confidence === level}
                className={`focus-ring transition-standard rounded-full px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
                  confidence === level ? "bg-accent text-accent-fg" : "border border-border text-fg-muted hover:bg-surface-hover"
                }`}
              >
                {level === "CONFIDENT" ? "Confident" : level === "UNSURE" ? "Unsure" : "Guessing"}
              </button>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <Button variant="ghost" size="sm" disabled={sending} onClick={() => void requestHint()}>
              💡 Hint
            </Button>
            {QUICK_ACTIONS.map((action) => (
              <Button key={action.label} variant="ghost" size="sm" disabled={sending} onClick={() => void send(action.text)}>
                {action.label}
              </Button>
            ))}
            {session.mode !== "TEACH_BACK" && (
              <Button variant="ghost" size="sm" disabled={sending} onClick={() => void postAction(`/api/tutor/sessions/${session.id}/teach-back`)}>
                Explain it back to me
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
