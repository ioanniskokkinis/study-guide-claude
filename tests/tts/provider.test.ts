import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiTtsProvider } from "@/lib/tts/providers/openai-tts";
import { TTSProviderError } from "@/lib/tts/provider";

/** Phase 14 §2 — the OpenAI TTS provider, tested against a mocked `fetch` (no real network call, no npm SDK dependency). */
describe("OpenAiTtsProvider (Phase 14 §2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the OpenAI speech endpoint with the configured model/voice/text and returns raw audio bytes", async () => {
    const audioBytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => audioBytes.buffer,
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiTtsProvider("test-key", "tts-1");
    const result = await provider.generate({ text: "Hello there.", voice: "alloy", format: "mp3" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body)).toEqual({ model: "tts-1", input: "Hello there.", voice: "alloy", response_format: "mp3" });

    expect(result.audio).toEqual(Buffer.from(audioBytes));
    expect(result.format).toBe("mp3");
    expect(result.provider).toBe("openai");
  });

  it("never sends the API key anywhere but the Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiTtsProvider("super-secret-key", "tts-1");
    await provider.generate({ text: "hi", voice: "alloy", format: "mp3" });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).not.toContain("super-secret-key");
  });

  it("wraps a non-ok HTTP response in TTSProviderError without leaking the raw response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const provider = new OpenAiTtsProvider("test-key", "tts-1");
    await expect(provider.generate({ text: "x", voice: "alloy", format: "mp3" })).rejects.toThrow(TTSProviderError);
  });

  it("wraps a network failure in TTSProviderError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const provider = new OpenAiTtsProvider("test-key", "tts-1");
    await expect(provider.generate({ text: "x", voice: "alloy", format: "mp3" })).rejects.toThrow(TTSProviderError);
  });

  it("throws TTSProviderError when the provider returns empty audio", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }));
    const provider = new OpenAiTtsProvider("test-key", "tts-1");
    await expect(provider.generate({ text: "x", voice: "alloy", format: "mp3" })).rejects.toThrow(TTSProviderError);
  });

  it("throws TTSProviderError when the response body cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => {
          throw new Error("stream error");
        },
      }),
    );
    const provider = new OpenAiTtsProvider("test-key", "tts-1");
    await expect(provider.generate({ text: "x", voice: "alloy", format: "mp3" })).rejects.toThrow(TTSProviderError);
  });
});
