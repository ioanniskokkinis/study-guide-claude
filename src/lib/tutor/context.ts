import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";

/**
 * Deterministic (zero-Claude-call) conversation summarization (Phase 12 §7).
 * Before this, a session's messages older than `CONVERSATION_HISTORY_WINDOW`
 * were silently dropped from every prompt — bounded and cheap, but losing
 * real signal (how many hints were already given, how many times the
 * student got it wrong) on long sessions. This recovers that signal as a
 * short, non-AI-generated line instead of calling Claude to summarize
 * (spec §7 explicitly rules out an AI call for this), only for sessions
 * long enough that `getTutorContext` decides the recent window alone isn't
 * enough (see AI_CONTEXT_MAX_MESSAGES).
 */
const MESSAGE_TYPE_LABELS: Record<string, string> = {
  QUESTION: "question asked",
  FOLLOWUP: "follow-up asked",
  HINT: "hint given",
  EXPLANATION: "explanation given",
  FEEDBACK: "feedback given",
  TEACH_BACK_PROMPT: "teach-back prompt",
  REMEDIATION: "remediation step",
  COMPLETION: "completion message",
};

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Returns null when the session is short enough that the recent-messages
 * window (`recentWindow`) already covers everything — the common case, and
 * the cheapest: one lightweight query, no summary line added to the prompt
 * at all. Only sessions with more than `AI_CONTEXT_MAX_MESSAGES` total
 * messages get a summary of the turns older than `recentWindow`.
 */
export async function buildConversationSummary(sessionId: string, recentWindow: number): Promise<string | null> {
  const messages = await prisma.tutorMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
    select: { role: true, messageType: true },
  });
  if (messages.length <= env.AI_CONTEXT_MAX_MESSAGES) return null;

  const older = messages.slice(0, Math.max(0, messages.length - recentWindow));
  if (older.length === 0) return null;

  const tally = new Map<string, number>();
  let studentTurns = 0;
  for (const m of older) {
    if (m.role === "STUDENT") {
      studentTurns += 1;
      continue;
    }
    const label = MESSAGE_TYPE_LABELS[m.messageType] ?? m.messageType.toLowerCase();
    tally.set(label, (tally.get(label) ?? 0) + 1);
  }

  const parts = Array.from(tally.entries()).map(([label, count]) => pluralize(count, label));
  if (studentTurns > 0) parts.push(pluralize(studentTurns, "student response"));

  return `Earlier in this session (${older.length} earlier turns not shown in full below): ${parts.join(", ")}.`;
}
