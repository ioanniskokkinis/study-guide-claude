/**
 * The one shared Server-Sent Events mechanism every Tutor streaming route
 * uses (Phase 11 §2, consolidated here in Phase 13 §2) — normal Tutor
 * messages, the opening Tutor question, and hints all wrap their event
 * generator with this same function rather than each route hand-rolling
 * its own `ReadableStream`.
 */
export function sseFrame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/**
 * Wraps any async generator of protocol events into an SSE
 * `ReadableStream`. Every generator in this codebase already catches its
 * own expected failures (a bad session id, a Claude error, an abort) and
 * yields a structured `{type:"error"}` event itself — `onUnexpectedError`
 * is only a backstop for something escaping that, so even a genuine bug
 * still reaches the client as a well-formed event instead of a silently
 * truncated stream.
 */
export function createSseStream<T>(source: AsyncGenerator<T, void, void>, onUnexpectedError: (error: unknown) => T): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const enqueue = (event: T) => {
        try {
          controller.enqueue(encoder.encode(sseFrame(event)));
        } catch {
          // The client disconnected and the controller is already closed — nothing left to send.
        }
      };

      try {
        for await (const event of source) enqueue(event);
      } catch (error) {
        enqueue(onUnexpectedError(error));
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed (e.g. after a client abort) — safe to ignore.
        }
      }
    },
    cancel() {
      // Real cancellation happens via the AbortSignal already threaded into the source generator
      // (see each route) — that's what actually stops the in-flight Anthropic call. This callback
      // exists only so the platform's own stream bookkeeping is satisfied.
    },
  });
}
