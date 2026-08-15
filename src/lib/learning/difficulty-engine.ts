import { prisma } from "@/lib/db/prisma";

/**
 * Basic adaptive difficulty (spec §7): a small recent-performance window,
 * not a full IRT/ELO model. Deterministic, DB-driven from real
 * LearningAttempt history (Phase 4) — never adjusted from a single answer.
 */

export const RECENT_PERFORMANCE_WINDOW = 3;
export const INCREASE_THRESHOLD = 0.85;
export const MAINTAIN_THRESHOLD = 0.6;
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 5;
/** Below this many recent data points, difficulty holds steady rather than reacting to noise. */
export const MIN_ATTEMPTS_BEFORE_ADJUSTING = 2;

export function clampDifficulty(n: number): number {
  return Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, Math.round(n)));
}

/**
 * Pure: last-N performance scores (0-1, most-recent-first or in any order —
 * only the average matters) -> next difficulty. >=85% up a level, 60-84%
 * hold, <60% down a level, clamped to [1,5].
 */
export function computeNextDifficulty(currentDifficulty: number, recentScores: number[]): number {
  if (recentScores.length < MIN_ATTEMPTS_BEFORE_ADJUSTING) {
    return clampDifficulty(currentDifficulty);
  }

  const average = recentScores.reduce((sum, score) => sum + score, 0) / recentScores.length;

  if (average >= INCREASE_THRESHOLD) return clampDifficulty(currentDifficulty + 1);
  if (average >= MAINTAIN_THRESHOLD) return clampDifficulty(currentDifficulty);
  return clampDifficulty(currentDifficulty - 1);
}

/** Most recent attempts' score (falling back to correctness), newest first, capped to the window. */
export async function getRecentPerformance(
  userId: string,
  conceptId: string,
  windowSize: number = RECENT_PERFORMANCE_WINDOW,
): Promise<number[]> {
  const attempts = await prisma.learningAttempt.findMany({
    where: { userId, conceptId },
    orderBy: { createdAt: "desc" },
    take: windowSize,
    select: { score: true, correctness: true },
  });

  return attempts.map((a) => a.score ?? a.correctness).filter((value): value is number => value != null);
}

/** The difficulty of the student's most recent attempt on this concept, or `fallback` if there is none yet. */
export async function getCurrentDifficulty(userId: string, conceptId: string, fallback: number): Promise<number> {
  const [lastAttempt] = await prisma.learningAttempt.findMany({
    where: { userId, conceptId },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { difficulty: true },
  });

  return clampDifficulty(lastAttempt?.difficulty ?? fallback);
}

/** DB-aware convenience wrapper: loads the current difficulty and recent window, then applies computeNextDifficulty. */
export async function selectDifficultyForConcept(userId: string, conceptId: string, fallback: number): Promise<number> {
  const [current, recentScores] = await Promise.all([
    getCurrentDifficulty(userId, conceptId, fallback),
    getRecentPerformance(userId, conceptId),
  ]);

  return computeNextDifficulty(current, recentScores);
}
