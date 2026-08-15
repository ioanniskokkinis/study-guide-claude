import { prisma } from "@/lib/db/prisma";
import type { StudentMistakeCategory } from "@/generated/prisma/client";
import { getPrerequisiteStatus, type PrerequisiteStatusNode } from "@/lib/services/student-knowledge";
import { PREREQUISITE_MASTERY_THRESHOLD } from "@/lib/learning/adaptive/config";
import { calculatePrerequisiteImportance } from "@/lib/learning/adaptive/concept-scoring";
import { getStudentLearningState } from "@/lib/learning/adaptive/student-state";
import { MISTAKE_SEVERITY_WEIGHTS } from "./config";
import type {
  AnswerGrading,
  ClassifiedMistake,
  ExamAnswerClassificationValue,
  ExamMistakeCategoryValue,
  PrerequisiteDiagnosis,
} from "./types";

/**
 * Classifies exam mistakes and diagnoses whether a failure actually
 * originates upstream in the prerequisite graph (spec §24-27) — never
 * assumes the tested concept is where the gap lives. Reuses Phase 4's
 * recursive getPrerequisiteStatus() rather than re-deriving prerequisite
 * traversal (spec §26 explicitly walks multiple hops: Firewalls -> Ports
 * -> TCP -> Networking, not just the one direct prerequisite).
 */

/** Independent of StudentMistakeCategory (Phase 4) — mapped down when persisted so exam mistakes still land in the one cross-phase mistake history (see prisma schema comment on ExamMistakeCategory). */
export function toStudentMistakeCategory(category: ExamMistakeCategoryValue): StudentMistakeCategory {
  switch (category) {
    case "KNOWLEDGE_GAP":
      return "CONCEPTUAL_GAP";
    case "MISCONCEPTION":
      return "MISCONCEPTION";
    case "RECALL_FAILURE":
      return "FACTUAL_ERROR";
    case "REASONING_FAILURE":
      return "REASONING_ERROR";
    case "APPLICATION_FAILURE":
      return "APPLICATION_FAILURE";
    case "PREREQUISITE_FAILURE":
      return "PREREQUISITE_GAP";
    case "CARELESS_ERROR":
      return "CARELESS_ERROR";
    case "INCOMPLETE_ANSWER":
      return "INCOMPLETE_ANSWER";
    case "TIME_PRESSURE":
      return "CARELESS_ERROR";
    case "UNKNOWN":
      return "CONCEPTUAL_GAP";
  }
}

export interface ClassifyMistakeInput {
  questionId: string;
  conceptId: string;
  conceptName: string;
  classification: ExamAnswerClassificationValue;
  confidence: "CONFIDENT" | "UNSURE" | "GUESSING" | null;
  criteria: AnswerGrading["criteria"] | null;
  cognitiveLevel: "RECALL" | "UNDERSTAND" | "APPLY" | "ANALYZE" | "EVALUATE";
  missingConceptsCount: number;
  /** True when this answer was submitted with little time remaining in a timed exam. */
  underTimePressure: boolean;
}

/**
 * Deterministic category assignment (spec §24). A confident-but-wrong
 * answer is always escalated to MISCONCEPTION regardless of what Claude's
 * classification said (spec §19, mirrors Phase 7's illusion-of-competence
 * override) — that combination is the strongest signal available that the
 * student holds a specific wrong belief, not just a gap.
 */
export function classifyExamMistakeCategory(input: ClassifyMistakeInput): ExamMistakeCategoryValue {
  if (input.classification === "UNANSWERED") {
    return input.underTimePressure ? "TIME_PRESSURE" : "INCOMPLETE_ANSWER";
  }
  if (input.classification === "MISCONCEPTION") return "MISCONCEPTION";
  if (input.classification === "INCORRECT" && input.confidence === "CONFIDENT") return "MISCONCEPTION";

  if (!input.criteria) {
    // Auto-graded (multiple choice / true-false / multi-select): no rubric breakdown to reason from.
    return "RECALL_FAILURE";
  }

  const { correctness, completeness, reasoning, application } = input.criteria;
  if (input.underTimePressure && correctness >= 0.4) return "TIME_PRESSURE";
  if (completeness < 0.4 && correctness >= 0.5) return "INCOMPLETE_ANSWER";
  if ((input.cognitiveLevel === "APPLY" || input.cognitiveLevel === "ANALYZE") && application < reasoning - 0.15) {
    return "APPLICATION_FAILURE";
  }
  if (reasoning < correctness - 0.2) return "REASONING_FAILURE";
  if (input.missingConceptsCount > 0) return "KNOWLEDGE_GAP";
  return "KNOWLEDGE_GAP";
}

/** Severity depends on concept importance, frequency, prerequisite impact, and confidence mismatch (spec §25) — a weighted, deterministic 0-1 score banded into LOW/MEDIUM/HIGH/CRITICAL. */
export function computeMistakeSeverity(params: {
  conceptImportance: number; // 0-1, e.g. how many downstream concepts depend on this one
  occurrencesThisExam: number; // how many times this same category/concept has come up already
  hasPrerequisiteImpact: boolean;
  confidence: "CONFIDENT" | "UNSURE" | "GUESSING" | null;
}): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  const frequencyScore = Math.min(1, params.occurrencesThisExam / 3);
  const confidenceMismatch = params.confidence === "CONFIDENT" ? 1 : params.confidence === "UNSURE" ? 0.3 : 0;

  const score =
    params.conceptImportance * MISTAKE_SEVERITY_WEIGHTS.conceptImportance +
    frequencyScore * MISTAKE_SEVERITY_WEIGHTS.frequency +
    (params.hasPrerequisiteImpact ? 1 : 0) * MISTAKE_SEVERITY_WEIGHTS.prerequisiteImpact +
    confidenceMismatch * MISTAKE_SEVERITY_WEIGHTS.confidenceMismatch;

  if (score >= 0.75) return "CRITICAL";
  if (score >= 0.5) return "HIGH";
  if (score >= 0.25) return "MEDIUM";
  return "LOW";
}

function collectWeakAncestors(
  node: PrerequisiteStatusNode,
  depth: number,
  out: Array<{ conceptId: string; conceptName: string; mastery: number; depth: number }>,
): void {
  for (const child of node.prerequisites) {
    if (child.mastery.overallMastery < PREREQUISITE_MASTERY_THRESHOLD) {
      out.push({ conceptId: child.concept.id, conceptName: child.concept.name, mastery: child.mastery.overallMastery, depth });
    }
    collectWeakAncestors(child, depth + 1, out);
  }
}

/**
 * Walks the full prerequisite chain on a failure (spec §26) — e.g. Network
 * Attacks fails -> checks Firewalls, Ports, TCP, Networking, not just the
 * one direct prerequisite. Returns weak ancestors nearest-first.
 */
export async function diagnosePrerequisites(userId: string, conceptId: string, conceptName: string): Promise<PrerequisiteDiagnosis> {
  const tree = await getPrerequisiteStatus(userId, conceptId);
  const weakPrerequisites: PrerequisiteDiagnosis["weakPrerequisites"] = [];
  if (tree) collectWeakAncestors(tree, 1, weakPrerequisites);
  weakPrerequisites.sort((a, b) => a.depth - b.depth || a.mastery - b.mastery);

  return { failedConceptId: conceptId, failedConceptName: conceptName, weakPrerequisites };
}

export function describeMistake(category: ExamMistakeCategoryValue, conceptName: string, missingConcepts: string[]): string {
  switch (category) {
    case "KNOWLEDGE_GAP":
      return missingConcepts.length > 0
        ? `Missing key ideas on ${conceptName}: ${missingConcepts.join(", ")}.`
        : `Gaps in understanding of ${conceptName}.`;
    case "MISCONCEPTION":
      return `A specific wrong belief about ${conceptName} was demonstrated.`;
    case "RECALL_FAILURE":
      return `Could not recall a basic fact about ${conceptName}.`;
    case "REASONING_FAILURE":
      return `The reasoning process for ${conceptName} broke down, even though some facts were known.`;
    case "APPLICATION_FAILURE":
      return `Struggled to apply ${conceptName} to a new situation.`;
    case "PREREQUISITE_FAILURE":
      return `The gap traces back to a prerequisite of ${conceptName}, not ${conceptName} itself.`;
    case "CARELESS_ERROR":
      return `Likely a careless slip rather than a genuine gap in ${conceptName}.`;
    case "INCOMPLETE_ANSWER":
      return `The answer on ${conceptName} was on the right track but incomplete.`;
    case "TIME_PRESSURE":
      return `This answer on ${conceptName} was rushed near the time limit.`;
    case "UNKNOWN":
      return `Unable to determine the cause of this mistake on ${conceptName}.`;
  }
}

/**
 * The exam-level orchestration step (spec §24-27): loads every non-CORRECT
 * ExamAnswer, classifies it, computes severity from real signals (reusing
 * the adaptive engine's own prerequisite-importance scoring rather than a
 * second one, spec §13), and diagnoses whether a prerequisite gap explains
 * the failure. Called once per graded exam.
 */
export async function analyzeExamMistakes(examId: string, userId: string, courseId: string): Promise<ClassifiedMistake[]> {
  const answers = await prisma.examAnswer.findMany({
    where: { examId, classification: { notIn: ["CORRECT"] } },
    include: { question: { select: { conceptId: true, cognitiveLevel: true, concept: { select: { name: true } } } } },
  });
  if (answers.length === 0) return [];

  const allAnswers = await prisma.examAnswer.findMany({ where: { examId }, select: { timeSpentSeconds: true } });
  const times = allAnswers.map((a) => a.timeSpentSeconds).filter((t) => t > 0).sort((a, b) => a - b);
  const medianTime = times.length > 0 ? times[Math.floor(times.length / 2)] : 0;

  const state = await getStudentLearningState(userId, courseId);

  const occurrencesByKey = new Map<string, number>();
  const results: ClassifiedMistake[] = [];

  for (const answer of answers) {
    const conceptId = answer.question.conceptId;
    const conceptName = answer.question.concept.name;
    const criteria = answer.criteriaScores as unknown as ClassifyMistakeInput["criteria"];
    const confidence = (answer.confidence ?? null) as ClassifyMistakeInput["confidence"];
    const missingConcepts = Array.isArray(answer.missingConcepts) ? (answer.missingConcepts as string[]) : [];
    const underTimePressure = medianTime > 0 && answer.timeSpentSeconds > 0 && answer.timeSpentSeconds < medianTime * 0.2;

    const category = classifyExamMistakeCategory({
      questionId: answer.questionId,
      conceptId,
      conceptName,
      classification: answer.classification ?? "UNANSWERED",
      confidence,
      criteria,
      cognitiveLevel: answer.question.cognitiveLevel,
      missingConceptsCount: missingConcepts.length,
      underTimePressure,
    });

    const key = `${conceptId}:${category}`;
    const occurrences = (occurrencesByKey.get(key) ?? 0) + 1;
    occurrencesByKey.set(key, occurrences);

    const conceptImportance = state ? calculatePrerequisiteImportance(conceptId, state) : 0.5;
    const prerequisiteDiagnosis =
      category === "MISCONCEPTION" || category === "PREREQUISITE_FAILURE" || occurrences >= 1
        ? await diagnosePrerequisites(userId, conceptId, conceptName)
        : null;
    const hasPrerequisiteImpact = !!prerequisiteDiagnosis && prerequisiteDiagnosis.weakPrerequisites.length > 0;

    const severity = computeMistakeSeverity({ conceptImportance, occurrencesThisExam: occurrences, hasPrerequisiteImpact, confidence });

    results.push({
      questionId: answer.questionId,
      conceptId,
      category: hasPrerequisiteImpact && category === "KNOWLEDGE_GAP" ? "PREREQUISITE_FAILURE" : category,
      severity,
      description: describeMistake(category, conceptName, missingConcepts),
      prerequisiteDiagnosis: hasPrerequisiteImpact ? prerequisiteDiagnosis : null,
    });
  }

  return results;
}

export type { ClassifiedMistake };
