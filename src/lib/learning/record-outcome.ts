import { prisma } from "@/lib/db/prisma";
import type {
  EvidenceOutcome,
  EvidenceSourceType,
  KnowledgeEvidence,
  LearningActivityType,
  LearningAttempt,
  MistakeSeverity,
  StudentConceptMastery,
  StudentMistake,
  StudentMistakeCategory,
} from "@/generated/prisma/client";
import { deriveOutcomeFromScore, updateMastery, type EvidenceInput } from "./mastery-engine";

export interface MistakeInput {
  category: StudentMistakeCategory;
  description: string;
  severity?: MistakeSeverity;
}

export interface RecordLearningOutcomeInput {
  userId: string;
  conceptId: string;
  activityType: LearningActivityType;
  /** 0-1 dimension-level score for this attempt; also what mastery is updated from. */
  score: number;
  /** 0-1; defaults to `score` when the caller doesn't distinguish correctness from the mastery score. */
  correctness?: number | null;
  /** 0-1 normalized self-reported confidence (spec §12), or omitted if not collected. */
  confidence?: number | null;
  /** Derived from `score` via deriveOutcomeFromScore when omitted. */
  outcome?: EvidenceOutcome;
  difficulty?: number;
  usedHint?: boolean;
  revealedAnswer?: boolean;
  durationSeconds?: number | null;
  /**
   * Pre-classified mistakes to record alongside this attempt. Phase 4 does
   * not classify mistakes itself (spec §28) — a future AI evaluation step
   * (Phase 5) or manual entry supplies these already categorized.
   */
  mistakes?: MistakeInput[];
  sourceType?: EvidenceSourceType;
  notes?: string | null;
}

export interface RecordLearningOutcomeResult {
  attempt: LearningAttempt;
  evidence: KnowledgeEvidence;
  mistakes: StudentMistake[];
  mastery: StudentConceptMastery;
}

/**
 * The single entry point for turning "a student did something" into
 * persisted student knowledge state (spec §26-27). Creates the
 * LearningAttempt, the derived KnowledgeEvidence, any StudentMistake rows,
 * and the resulting StudentConceptMastery update, all in one transaction so
 * a partial write can never leave mastery out of sync with its evidence.
 *
 * Deliberately source-agnostic (spec §31): it doesn't know or care whether
 * `score`/`confidence` came from an auto-graded question, a Claude
 * evaluation of free text, or a manual entry — it only consumes already
 * structured learning evidence. Every future study mode (Phase 5+) is
 * expected to funnel through this function rather than writing to the
 * student-model tables directly.
 *
 * Returns null if the concept doesn't exist or isn't owned by `userId`
 * (never throws for that case — matches the rest of the service layer).
 */
export async function recordLearningOutcome(
  input: RecordLearningOutcomeInput,
): Promise<RecordLearningOutcomeResult | null> {
  const concept = await prisma.concept.findUnique({
    where: { id: input.conceptId },
    select: { course: { select: { userId: true } } },
  });
  if (!concept || concept.course.userId !== input.userId) {
    return null;
  }

  const outcome = input.outcome ?? deriveOutcomeFromScore(input.score);
  const correctness = input.correctness ?? input.score;

  return prisma.$transaction(async (tx) => {
    const attempt = await tx.learningAttempt.create({
      data: {
        userId: input.userId,
        conceptId: input.conceptId,
        activityType: input.activityType,
        difficulty: input.difficulty ?? 1,
        score: input.score,
        correctness,
        confidence: input.confidence ?? null,
        usedHint: input.usedHint ?? false,
        revealedAnswer: input.revealedAnswer ?? false,
        durationSeconds: input.durationSeconds ?? null,
      },
    });

    const evidence = await tx.knowledgeEvidence.create({
      data: {
        userId: input.userId,
        conceptId: input.conceptId,
        sourceType: input.sourceType ?? "QUESTION",
        sourceId: attempt.id,
        outcome,
        score: input.score,
        confidence: input.confidence ?? null,
        notes: input.notes ?? null,
      },
    });

    const mistakes: StudentMistake[] = [];
    for (const mistakeInput of input.mistakes ?? []) {
      mistakes.push(
        await tx.studentMistake.create({
          data: {
            userId: input.userId,
            conceptId: input.conceptId,
            attemptId: attempt.id,
            category: mistakeInput.category,
            description: mistakeInput.description,
            severity: mistakeInput.severity ?? "MEDIUM",
          },
        }),
      );
    }

    const evidenceInput: EvidenceInput = {
      activityType: input.activityType,
      score: input.score,
      outcome,
      confidence: input.confidence,
      usedHint: input.usedHint,
      revealedAnswer: input.revealedAnswer,
    };

    const mastery = await updateMastery(tx, {
      userId: input.userId,
      conceptId: input.conceptId,
      evidence: evidenceInput,
    });

    return { attempt, evidence, mistakes, mastery };
  });
}
