import type { Exam } from "@/generated/prisma/client";

/**
 * Server-side exam timing (spec §16, §55) — the client's timer is display
 * only; every duration/expiry check the application actually acts on goes
 * through these functions instead.
 */

export function computeRemainingSeconds(exam: Pick<Exam, "timeLimitSeconds" | "startedAt">, now: Date = new Date()): number | null {
  if (exam.timeLimitSeconds == null || !exam.startedAt) return null;
  const elapsedSeconds = Math.floor((now.getTime() - exam.startedAt.getTime()) / 1000);
  return Math.max(0, exam.timeLimitSeconds - elapsedSeconds);
}

export function isExamTimeExpired(exam: Pick<Exam, "timeLimitSeconds" | "startedAt">, now: Date = new Date()): boolean {
  const remaining = computeRemainingSeconds(exam, now);
  return remaining !== null && remaining <= 0;
}
