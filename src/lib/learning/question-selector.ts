import { prisma } from "@/lib/db/prisma";
import {
  bucketForStatus,
  getCourseMastery,
  getKnowledgeSnapshot,
  getRecentMistakes,
  type ConceptMasterySummary,
  type MasteryBucket,
} from "@/lib/services/student-knowledge";
import { selectDifficultyForConcept } from "./difficulty-engine";
import type { QuestionGenerationTypeSchema } from "@/lib/ai/prompts/question-generation";
import type { z } from "zod";

export type GeneratedQuestionType = z.infer<typeof QuestionGenerationTypeSchema>;

export interface LearningTarget {
  conceptId: string;
  conceptName: string;
  reason: string;
  suggestedDifficulty: number;
  questionType: GeneratedQuestionType;
}

/** Foundational retrieval first for unseen/weak ground; explanation for developing; application once it's holding up. */
function questionTypeForBucket(bucket: MasteryBucket): GeneratedQuestionType {
  switch (bucket) {
    case "unknown":
    case "weak":
      return "RECALL";
    case "developing":
      return "EXPLAIN";
    case "strong":
      return "APPLY";
  }
}

const BUCKET_SCORE: Record<MasteryBucket, number> = {
  weak: 50,
  developing: 30,
  unknown: 10,
  strong: 2,
};
const PREREQUISITE_GAP_BONUS = 100;
const RECENT_MISTAKE_BONUS = 20;

async function buildTargetForConcept(
  userId: string,
  concept: ConceptMasterySummary,
  reason: string,
): Promise<LearningTarget> {
  const bucket = bucketForStatus(concept.status);
  const courseConceptDifficulty = await prisma.concept.findUnique({
    where: { id: concept.conceptId },
    select: { difficulty: true },
  });

  const suggestedDifficulty = await selectDifficultyForConcept(
    userId,
    concept.conceptId,
    courseConceptDifficulty?.difficulty ?? 2,
  );

  return {
    conceptId: concept.conceptId,
    conceptName: concept.conceptName,
    reason,
    suggestedDifficulty,
    questionType: questionTypeForBucket(bucket),
  };
}

/**
 * Chooses which concept (and roughly what kind of question) Active Recall
 * should ask about next — the selection half of spec §8/§31. This is
 * deliberately NOT the full "what should I study?" planner (that's a later
 * phase) — it only picks one target at a time, prioritizing:
 *
 *   1. a concept the last answer's evaluator flagged as a validated
 *      prerequisite gap (forceConceptId — spec §29 "if prerequisite gap
 *      detected, next question should target prerequisite")
 *   2. concepts that are both weak AND a prerequisite of another weak
 *      concept (the TCP/Ports/Firewalls example, spec §8)
 *   3. weak concepts
 *   4. developing concepts
 *   5. concepts with a recent unresolved mistake (boosts whichever bucket they're already in)
 *   6. unknown concepts (some exposure to new material)
 *   7. strong/mastered concepts (lowest priority — spec §26: don't spend
 *      most questions on already-mastered material, but don't fully starve
 *      review either)
 *
 * Returns null only if the course has no concepts to select from yet.
 */
export async function selectNextLearningTarget(params: {
  userId: string;
  courseId: string;
  /** A concept to target directly (e.g. a validated prerequisite gap from the previous answer), bypassing scoring. */
  forceConceptId?: string;
}): Promise<LearningTarget | null> {
  const { userId, courseId } = params;

  if (params.forceConceptId) {
    const forced = await prisma.concept.findFirst({
      where: { id: params.forceConceptId, courseId },
      select: { id: true, name: true },
    });
    if (forced) {
      const courseMastery = await getCourseMastery(userId, courseId);
      const summary =
        courseMastery?.concepts.find((c) => c.conceptId === forced.id) ??
        ({
          conceptId: forced.id,
          conceptName: forced.name,
          status: "UNKNOWN",
          overallMastery: 0,
          recallScore: 0,
          explanationScore: 0,
          applicationScore: 0,
          transferScore: 0,
          confidenceScore: 0,
          exposureCount: 0,
          attemptCount: 0,
          successCount: 0,
          failureCount: 0,
          hintCount: 0,
          revealCount: 0,
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastFailureAt: null,
        } satisfies ConceptMasterySummary);

      return buildTargetForConcept(
        userId,
        summary,
        `Your last answer suggested a gap in ${forced.name}, a prerequisite for the concept you were working on.`,
      );
    }
    // Forced concept wasn't valid for this course/user — fall through to normal selection.
  }

  const [courseMastery, snapshot, recentMistakes] = await Promise.all([
    getCourseMastery(userId, courseId),
    getKnowledgeSnapshot(userId, courseId),
    getRecentMistakes(userId, courseId, { limit: 20, unresolvedOnly: true }),
  ]);

  if (!courseMastery || courseMastery.concepts.length === 0) {
    return null;
  }

  const prerequisiteGapConceptIds = new Set(snapshot?.prerequisiteGaps.map((g) => g.prerequisite.conceptId) ?? []);
  const recentMistakeConceptIds = new Set(recentMistakes?.map((m) => m.conceptId) ?? []);

  let best: { concept: ConceptMasterySummary; score: number } | null = null;
  for (const concept of courseMastery.concepts) {
    const bucket = bucketForStatus(concept.status);
    let score = BUCKET_SCORE[bucket];
    if (prerequisiteGapConceptIds.has(concept.conceptId)) score += PREREQUISITE_GAP_BONUS;
    if (recentMistakeConceptIds.has(concept.conceptId)) score += RECENT_MISTAKE_BONUS;

    if (
      !best ||
      score > best.score ||
      (score === best.score && compareForTieBreak(concept, best.concept) < 0)
    ) {
      best = { concept, score };
    }
  }

  if (!best) return null;

  const isPrerequisiteGap = prerequisiteGapConceptIds.has(best.concept.conceptId);
  const hasRecentMistake = recentMistakeConceptIds.has(best.concept.conceptId);
  const bucket = bucketForStatus(best.concept.status);

  let reason: string;
  if (isPrerequisiteGap) {
    const gap = snapshot!.prerequisiteGaps.find((g) => g.prerequisite.conceptId === best!.concept.conceptId)!;
    reason = `${gap.prerequisite.conceptName} is a prerequisite of ${gap.concept.conceptName}, which needs reinforcement.`;
  } else if (hasRecentMistake) {
    reason = `You made a recent mistake on ${best.concept.conceptName} that hasn't been reviewed yet.`;
  } else if (bucket === "weak") {
    reason = `${best.concept.conceptName} needs reinforcement based on your recent performance.`;
  } else if (bucket === "developing") {
    reason = `${best.concept.conceptName} is still developing — a good concept to reinforce next.`;
  } else if (bucket === "unknown") {
    reason = `${best.concept.conceptName} hasn't been assessed yet.`;
  } else {
    reason = `${best.concept.conceptName} for periodic reinforcement.`;
  }

  return buildTargetForConcept(userId, best.concept, reason);
}

/** Never-attempted concepts sort first (spread attention before repeating). */
function compareForTieBreak(a: ConceptMasterySummary, b: ConceptMasterySummary): number {
  const aTime = a.lastAttemptAt?.getTime() ?? -Infinity;
  const bTime = b.lastAttemptAt?.getTime() ?? -Infinity;
  return aTime - bTime;
}
