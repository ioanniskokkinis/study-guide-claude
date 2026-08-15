import { prisma } from "@/lib/db/prisma";
import type { MistakeSeverity, StudentMisconception } from "@/generated/prisma/client";
import {
  MISCONCEPTION_CONFIDENCE_DECAY_PER_EVIDENCE,
  MISCONCEPTION_INITIAL_CONFIDENCE,
  MISCONCEPTION_RESOLUTION_EVIDENCE_COUNT,
  MISCONCEPTION_RESOLVED_CONFIDENCE_FLOOR,
} from "./config";
import type { MisconceptionState } from "./types";

/**
 * Detected misconceptions are persisted to StudentMisconception (reusing
 * the model rather than inventing a second one — spec §12) and require
 * multiple pieces of independent evidence to clear (spec §13): a single
 * correct answer never resolves one. This module keeps at most one active
 * (unresolved) misconception per (userId, conceptId) — a reasonable
 * simplification of spec §13's worked example, which only ever tracks one
 * misconception through detection -> remediation -> resolution at a time.
 */

/** Creates a new misconception record, or reinforces the existing unresolved one for this concept (spec §12). */
export async function recordMisconceptionDetection(params: {
  userId: string;
  conceptId: string;
  description: string;
  severity: MistakeSeverity;
}): Promise<StudentMisconception> {
  const existing = await prisma.studentMisconception.findFirst({
    where: { userId: params.userId, conceptId: params.conceptId, resolved: false },
    orderBy: { lastDetectedAt: "desc" },
  });

  if (existing) {
    return prisma.studentMisconception.update({
      where: { id: existing.id },
      data: {
        description: params.description,
        severity: worseSeverity(existing.severity, params.severity),
        confidence: Math.min(1, existing.confidence + MISCONCEPTION_INITIAL_CONFIDENCE[params.severity]),
        occurrenceCount: { increment: 1 },
        correctSinceCount: 0,
        lastDetectedAt: new Date(),
      },
    });
  }

  return prisma.studentMisconception.create({
    data: {
      userId: params.userId,
      conceptId: params.conceptId,
      description: params.description,
      severity: params.severity,
      confidence: MISCONCEPTION_INITIAL_CONFIDENCE[params.severity],
    },
  });
}

const SEVERITY_RANK: Record<MistakeSeverity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

function worseSeverity(a: MistakeSeverity, b: MistakeSeverity): MistakeSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Applies one piece of independent correct evidence (a correct, non-hinted,
 * non-revealed answer) to every unresolved misconception on this concept:
 * confidence decays, correctSinceCount grows, and resolution requires both
 * to cross their thresholds (spec §13) — never just one correct answer.
 * Returns the ids of any misconceptions that became resolved by this call.
 */
export async function recordIndependentCorrectEvidence(userId: string, conceptId: string): Promise<string[]> {
  const active = await prisma.studentMisconception.findMany({
    where: { userId, conceptId, resolved: false },
  });
  if (active.length === 0) return [];

  const resolvedIds: string[] = [];
  await Promise.all(
    active.map(async (m) => {
      const correctSinceCount = m.correctSinceCount + 1;
      const confidence = Math.max(0, m.confidence - MISCONCEPTION_CONFIDENCE_DECAY_PER_EVIDENCE);
      const resolved =
        correctSinceCount >= MISCONCEPTION_RESOLUTION_EVIDENCE_COUNT && confidence <= MISCONCEPTION_RESOLVED_CONFIDENCE_FLOOR;
      if (resolved) resolvedIds.push(m.id);

      await prisma.studentMisconception.update({
        where: { id: m.id },
        data: {
          correctSinceCount,
          confidence,
          resolved,
          resolvedAt: resolved ? new Date() : null,
        },
      });
    }),
  );

  return resolvedIds;
}

/** Completion criteria (spec §49) require no *active high-severity* misconception — LOW/MEDIUM don't block completion. */
export function hasActiveHighSeverityMisconception(misconceptions: MisconceptionState[]): boolean {
  return misconceptions.some((m) => m.severity === "HIGH" || m.severity === "CRITICAL");
}
