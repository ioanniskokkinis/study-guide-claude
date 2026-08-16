import { describe, expect, it } from "vitest";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { checkRateLimit } from "@/lib/rate-limit";
import { POST as postTts } from "@/app/api/tutor/tts/route";

/**
 * Phase 14 §4/§6/§20/§23 — the TTS API route, exercised against this
 * sandbox's real (disabled-by-default) env. Request validation and rate
 * limiting are enforced before TTS-enablement is even checked, so all of
 * this is testable without mocking anything.
 */
describe("POST /api/tutor/tts (Phase 14)", () => {
  it("rejects a request with no messageId", async () => {
    const request = new Request("http://localhost/api/tutor/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const response = await postTts(request);
    expect(response.status).toBe(400);
  });

  it("rejects invalid JSON", async () => {
    const request = new Request("http://localhost/api/tutor/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const response = await postTts(request);
    expect(response.status).toBe(400);
  });

  it("returns 503 (not a raw 500) when TTS is disabled, even for a well-formed request", async () => {
    const request = new Request("http://localhost/api/tutor/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "does-not-matter" }),
    });
    const response = await postTts(request);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(typeof body.error).toBe("string");
  });

  it("never exposes a storage key or file path in an error response", async () => {
    const request = new Request("http://localhost/api/tutor/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "does-not-matter" }),
    });
    const response = await postTts(request);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toMatch(/storage|\/tutor\//i);
  });

  // Runs last deliberately — exhausts the in-memory rate-limit bucket for the dev user's "tutor-tts" key.
  it("enforces a rate limit before doing any TTS work", async () => {
    const user = await getCurrentUser();
    const key = `${user.id}:tutor-tts`;
    for (let i = 0; i < 30; i++) checkRateLimit(key, { maxRequests: 30, windowMs: 60_000 });
    const blocked = checkRateLimit(key, { maxRequests: 30, windowMs: 60_000 });
    expect(blocked.allowed).toBe(false);

    const request = new Request("http://localhost/api/tutor/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "x" }),
    });
    const response = await postTts(request);
    expect(response.status).toBe(429);
  });
});
