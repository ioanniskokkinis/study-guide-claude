import { getCurrentUser } from "@/lib/auth/dev-user";
import { checkRateLimit } from "@/lib/rate-limit";
import { synthesizeTutorMessage, TtsDisabledError, TutorMessageNotEligibleError, TutorMessageNotFoundError } from "@/lib/tts/tutor-message-tts";
import { TTSProviderError } from "@/lib/tts/provider";

export const runtime = "nodejs";
export const maxDuration = 60;

interface TtsRequestBody {
  messageId?: string;
  part?: number;
}

function errorStatus(error: unknown): { status: number; message: string } {
  if (error instanceof TtsDisabledError) return { status: 503, message: error.message };
  if (error instanceof TutorMessageNotFoundError) return { status: 404, message: error.message };
  if (error instanceof TutorMessageNotEligibleError) return { status: 422, message: error.message };
  if (error instanceof TTSProviderError) return { status: 502, message: "Could not generate audio right now. Please try again." };
  return { status: 500, message: "Something went wrong." };
}

/**
 * Synthesizes speech for one persisted Tutor message (spec §4). The
 * browser never talks to the TTS provider directly — this route is the
 * only place `TTS_API_KEY` is ever read, and it's never sent to the
 * client. Authorization is enforced by `synthesizeTutorMessage()` deriving
 * ownership from the message's own session relation, never from a
 * client-asserted session id (spec §23). Returns raw audio bytes rather
 * than a JSON envelope with a URL, so no storage key or file path is ever
 * exposed to the browser (spec §10/§23).
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();

  const rateLimit = checkRateLimit(`${user.id}:tutor-tts`, { maxRequests: 30, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    return Response.json({ error: "Too many requests. Please wait a moment." }, { status: 429 });
  }

  let body: TtsRequestBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.messageId || typeof body.messageId !== "string") {
    return Response.json({ error: "messageId is required." }, { status: 400 });
  }
  const part = typeof body.part === "number" && Number.isInteger(body.part) && body.part >= 0 ? body.part : 0;

  try {
    const result = await synthesizeTutorMessage({ messageId: body.messageId, userId: user.id, part });
    return new Response(new Blob([new Uint8Array(result.audio)]), {
      status: 200,
      headers: {
        "Content-Type": result.format === "mp3" ? "audio/mpeg" : `audio/${result.format}`,
        "Cache-Control": "private, max-age=86400",
        "X-Tts-Part": String(result.part),
        "X-Tts-Total-Parts": String(result.totalParts),
        "X-Tts-Cache-Hit": String(result.cacheHit),
      },
    });
  } catch (error) {
    const { status, message } = errorStatus(error);
    return Response.json({ error: message }, { status });
  }
}
