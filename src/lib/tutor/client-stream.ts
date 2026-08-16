/**
 * The one client-side reader for every Tutor SSE stream (Phase 13 §2/§7) —
 * normal messages, the opening question, and hints all parse the exact
 * same event shapes through this same function, mirroring the server's
 * shared `TutorStreamEvent` protocol (src/lib/tutor/tutor-orchestrator.ts).
 * Kept independent of that server type (not imported directly) since every
 * route in this codebase is consumed as plain wire JSON, never through a
 * shared client/server type.
 */

export interface RawTutorMessage {
  id: string;
  role: "TUTOR" | "STUDENT" | "SYSTEM";
  content: string;
  messageType?: string;
}

export interface RawTutorSession {
  id: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "ABANDONED";
  mode: "SOCRATIC" | "TEACH_BACK" | "REMEDIATION";
  difficulty: number;
  questionsAnswered: number;
  hintLevel: number;
}

export type TutorClientStreamEvent =
  | { type: "start"; sessionId: string; action: string; aiGenerated: boolean }
  | { type: "delta"; text: string }
  | { type: "metadata"; latency: unknown }
  | { type: "complete"; session: RawTutorSession; message: RawTutorMessage }
  | { type: "error"; message: string };

/** Parses complete `data: ...\n\n` SSE frames out of a growing buffer, returning the leftover partial buffer. */
export function extractSseFrames(buffer: string): { frames: string[]; rest: string } {
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

/**
 * Reads `response.body` incrementally, decoding SSE frames as they arrive
 * and invoking `onEvent` for each one — the first delta is handed to the
 * caller as soon as its bytes land, never after the whole response
 * finishes. Malformed individual frames are skipped rather than aborting
 * the whole stream (a half-written frame at a chunk boundary is expected,
 * not an error). Resolves once the stream ends (`complete`, `error`, or
 * the connection simply closing) or rejects if `response.body` itself
 * throws (e.g. a genuine network failure or abort).
 */
export async function consumeTutorStream(response: Response, onEvent: (event: TutorClientStreamEvent) => void): Promise<void> {
  if (!response.body) throw new Error("Response has no body to stream.");

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
      try {
        onEvent(JSON.parse(line.slice("data: ".length)) as TutorClientStreamEvent);
      } catch {
        // Malformed frame — skip it rather than aborting the whole stream.
      }
    }
  }
}
