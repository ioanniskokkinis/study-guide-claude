import { TTSProviderError, type TTSGenerateParams, type TTSGenerateResult, type TTSProvider } from "../provider";

const OPENAI_SPEECH_ENDPOINT = "https://api.openai.com/v1/audio/speech";

/**
 * OpenAI's `/v1/audio/speech` TTS endpoint via a plain `fetch` call — no
 * SDK dependency needed for one REST call (same "smallest necessary
 * dependency" call made for streaming in Phase 11). Returns raw MP3 bytes.
 */
export class OpenAiTtsProvider implements TTSProvider {
  readonly name = "openai";

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async generate({ text, voice, format }: TTSGenerateParams): Promise<TTSGenerateResult> {
    let response: Response;
    try {
      response = await fetch(OPENAI_SPEECH_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: text,
          voice,
          response_format: format,
        }),
      });
    } catch (error) {
      throw new TTSProviderError("Could not reach the TTS provider.", error);
    }

    if (!response.ok) {
      // Never forward the raw response body (may echo the request, including text) into an error surfaced to the client — just the status.
      throw new TTSProviderError(`TTS provider request failed with status ${response.status}.`);
    }

    let arrayBuffer: ArrayBuffer;
    try {
      arrayBuffer = await response.arrayBuffer();
    } catch (error) {
      throw new TTSProviderError("TTS provider returned a malformed response.", error);
    }

    if (arrayBuffer.byteLength === 0) {
      throw new TTSProviderError("TTS provider returned empty audio.");
    }

    return { audio: Buffer.from(arrayBuffer), format, provider: this.name };
  }
}
