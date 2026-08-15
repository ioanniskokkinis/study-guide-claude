import { prisma } from "@/lib/db/prisma";
import type { ExamQuestion, Prisma } from "@/generated/prisma/client";
import { generateExamQuestionContent } from "./exam-evaluator";
import { allocateIntegers } from "./exam-blueprint";
import {
  MAX_GENERATION_ATTEMPTS,
  RECENT_EXAM_PROMPTS_TO_AVOID,
  SOURCE_CHUNKS_PER_EXAM_QUESTION,
} from "./config";
import type { CognitiveLevelValue, ExamBlueprint, ExamConfig, ExamQuestionTypeValue } from "./types";

/**
 * Turns an ExamBlueprint into real, source-grounded ExamQuestion rows.
 * Reuses the same reuse-before-generate / duplicate-detection / grounding-
 * refusal pattern as question-generator.ts (Phase 5) rather than a second,
 * parallel pipeline (spec §7) — but targets the ExamQuestion model, which
 * needs a response-format axis (options, correctOptionIds) Question
 * doesn't have.
 */

function normalizePrompt(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter(Boolean));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

async function isDuplicateExamQuestion(conceptId: string, prompt: string): Promise<boolean> {
  const normalized = normalizePrompt(prompt);
  const existing = await prisma.examQuestion.findMany({ where: { conceptId }, select: { prompt: true } });
  const candidateTokens = tokenSet(normalized);
  return existing.some((q) => {
    const existingNormalized = normalizePrompt(q.prompt);
    if (existingNormalized === normalized) return true;
    return jaccardSimilarity(candidateTokens, tokenSet(existingNormalized)) >= 0.85;
  });
}

/** Deterministic format choice by cognitive level (spec §7, §36) — no randomness, easy to reason about and test. */
export function questionTypeForCognitiveLevel(level: CognitiveLevelValue): ExamQuestionTypeValue {
  switch (level) {
    case "RECALL":
      return "MULTIPLE_CHOICE";
    case "UNDERSTAND":
      return "SHORT_ANSWER";
    case "APPLY":
      return "OPEN_ENDED";
    case "ANALYZE":
      return "PROBLEM_SOLVING";
    case "EVALUATE":
      return "OPEN_ENDED";
  }
}

/** Weak-tier questions run a notch easier (diagnostic, not punitive); strong-tier a notch harder (real confirmation, not a freebie) — ±1 around the exam's base difficulty (spec §10-11). */
export function difficultyForTier(baseDifficulty: number, tier: "strong" | "medium" | "weak"): number {
  const adjusted = tier === "weak" ? baseDifficulty - 1 : tier === "strong" ? baseDifficulty + 1 : baseDifficulty;
  return Math.min(5, Math.max(1, adjusted));
}

/**
 * Interleaved (not block-grouped) sequence of `count` cognitive levels
 * approximating `distribution` via largest-remainder rounding (spec §36) —
 * an exam shouldn't front-load all its RECALL questions before any APPLY
 * ones.
 */
export function assignCognitiveLevels(count: number, distribution: Record<CognitiveLevelValue, number>): CognitiveLevelValue[] {
  if (count <= 0) return [];
  const levels = Object.keys(distribution) as CognitiveLevelValue[];
  const counts = allocateIntegers(
    levels.map((l) => distribution[l]),
    count,
  );

  // Round-robin merge: repeatedly take one from whichever level still has the most remaining, spreading each level out across the sequence.
  const remaining = [...counts];
  const sequence: CognitiveLevelValue[] = [];
  for (let i = 0; i < count; i++) {
    let bestIdx = 0;
    for (let j = 1; j < remaining.length; j++) {
      if (remaining[j] > remaining[bestIdx]) bestIdx = j;
    }
    sequence.push(levels[bestIdx]);
    remaining[bestIdx] -= 1;
  }
  return sequence;
}

export interface GenerateExamQuestionParams {
  examId: string;
  courseId: string;
  conceptId: string;
  questionType: ExamQuestionTypeValue;
  cognitiveLevel: CognitiveLevelValue;
  difficulty: number;
  position: number;
  userId: string;
  excludeQuestionIds?: string[];
}

/**
 * Reuse-before-generate (mirrors question-generator.ts's getOrGenerateQuestion,
 * spec §7): looks for an existing, unused ExamQuestion at the right
 * concept/type/cognitive-level/difficulty first, only calling Claude if
 * nothing suitable exists. Returns null if generation isn't possible —
 * either no source material (spec §9) or every attempt was ungrounded or a
 * duplicate; callers should skip this slot rather than treat it as fatal.
 */
export async function getOrGenerateExamQuestion(params: GenerateExamQuestionParams): Promise<ExamQuestion | null> {
  const excludeQuestionIds = params.excludeQuestionIds ?? [];

  // Reuse only questions this specific user has never been asked before
  // (spec §47 — an exam must test knowledge, not memorization of a
  // question the student already saw) — a different user's past exam
  // question is still fair game and saves a Claude call.
  const reusable = await prisma.examQuestion.findFirst({
    where: {
      conceptId: params.conceptId,
      questionType: params.questionType,
      cognitiveLevel: params.cognitiveLevel,
      difficulty: params.difficulty,
      answer: { isNot: { userId: params.userId } },
      ...(excludeQuestionIds.length > 0 ? { id: { notIn: excludeQuestionIds } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  if (reusable) {
    // Attach it to this exam at the right position via a fresh row copy — ExamQuestion belongs to exactly one exam.
    return prisma.examQuestion.create({ data: { ...cloneForExam(reusable, params.examId, params.position) } });
  }

  const concept = await prisma.concept.findFirst({
    where: { id: params.conceptId, courseId: params.courseId },
    select: { id: true, name: true, description: true, course: { select: { title: true } } },
  });
  if (!concept) return null;

  const sources = await prisma.conceptSource.findMany({
    where: { conceptId: params.conceptId },
    orderBy: { relevance: "desc" },
    take: SOURCE_CHUNKS_PER_EXAM_QUESTION,
    select: { documentChunk: { select: { id: true, text: true } } },
  });
  if (sources.length === 0) return null;
  const sourceChunks = sources.map((s) => ({ id: s.documentChunk.id, text: s.documentChunk.text }));
  const knownChunkIds = new Set(sourceChunks.map((c) => c.id));

  const [prerequisiteEdges, recentQuestions] = await Promise.all([
    prisma.conceptRelationship.findMany({
      where: { relationshipType: "prerequisite", targetConceptId: params.conceptId },
      select: { sourceConceptId: true, sourceConcept: { select: { name: true } } },
    }),
    prisma.examQuestion.findMany({
      where: { conceptId: params.conceptId },
      orderBy: { createdAt: "desc" },
      take: RECENT_EXAM_PROMPTS_TO_AVOID,
      select: { prompt: true },
    }),
  ]);
  const prerequisiteIds = prerequisiteEdges.map((e) => e.sourceConceptId);
  const recentPrompts = recentQuestions.map((q) => q.prompt);

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const data = await generateExamQuestionContent(
      {
        courseTitle: concept.course.title,
        conceptName: concept.name,
        conceptDescription: concept.description ?? "(no description recorded)",
        sourceChunks,
        questionType: params.questionType,
        cognitiveLevel: params.cognitiveLevel,
        difficulty: params.difficulty,
        prerequisiteContext: prerequisiteEdges.map((e) => e.sourceConcept.name),
        recentPrompts,
      },
      params.userId,
    );

    if (!data.canGenerate || !data.prompt) continue;
    if (!isFormatComplete(params.questionType, data)) continue;

    const groundedChunkIds = (data.sourceChunkIds ?? []).filter((id) => knownChunkIds.has(id));
    if (groundedChunkIds.length === 0) continue;

    if (await isDuplicateExamQuestion(params.conceptId, data.prompt)) {
      recentPrompts.push(data.prompt);
      continue;
    }

    return prisma.examQuestion.create({
      data: {
        examId: params.examId,
        conceptId: params.conceptId,
        questionType: params.questionType,
        cognitiveLevel: params.cognitiveLevel,
        difficulty: params.difficulty,
        position: params.position,
        prompt: data.prompt,
        options: data.options as unknown as Prisma.InputJsonValue,
        correctOptionIds: data.correctOptionIds as unknown as Prisma.InputJsonValue,
        expectedAnswer: data.expectedAnswer ?? null,
        rubric: (data.rubric ?? null) as unknown as Prisma.InputJsonValue,
        scenario: (data.scenario ?? null) as unknown as Prisma.InputJsonValue,
        sourceReferences: groundedChunkIds as unknown as Prisma.InputJsonValue,
        prerequisiteConceptIds: prerequisiteIds as unknown as Prisma.InputJsonValue,
      },
    });
  }

  return null;
}

function isFormatComplete(
  questionType: ExamQuestionTypeValue,
  data: { options?: unknown[]; correctOptionIds?: unknown[]; expectedAnswer?: string; rubric?: unknown[]; scenario?: unknown },
): boolean {
  if (questionType === "MULTIPLE_CHOICE" || questionType === "MULTI_SELECT" || questionType === "TRUE_FALSE") {
    return !!data.options && data.options.length >= 2 && !!data.correctOptionIds && data.correctOptionIds.length > 0;
  }
  if (questionType === "SCENARIO") {
    return !!data.scenario && !!data.rubric && data.rubric.length > 0;
  }
  return !!data.expectedAnswer && !!data.rubric && data.rubric.length > 0;
}

function cloneForExam(source: ExamQuestion, examId: string, position: number): Prisma.ExamQuestionCreateInput {
  return {
    exam: { connect: { id: examId } },
    concept: { connect: { id: source.conceptId } },
    questionType: source.questionType,
    cognitiveLevel: source.cognitiveLevel,
    difficulty: source.difficulty,
    position,
    prompt: source.prompt,
    options: source.options as Prisma.InputJsonValue,
    correctOptionIds: source.correctOptionIds as Prisma.InputJsonValue,
    expectedAnswer: source.expectedAnswer,
    rubric: source.rubric as Prisma.InputJsonValue,
    scenario: source.scenario as Prisma.InputJsonValue,
    sourceReferences: source.sourceReferences as Prisma.InputJsonValue,
    prerequisiteConceptIds: source.prerequisiteConceptIds as Prisma.InputJsonValue,
    learningObjective: source.learningObjective,
    points: source.points,
  };
}

/**
 * Pre-generates the full question set for a WRITTEN or SCENARIO exam from
 * its blueprint (spec §5). ADAPTIVE mode only pre-generates the opening
 * question — see adaptive-exam.ts for the rest; ORAL mode doesn't use this
 * at all — see oral-exam.ts.
 */
export async function generateExamFromBlueprint(params: {
  examId: string;
  courseId: string;
  blueprint: ExamBlueprint;
  config: ExamConfig;
  userId: string;
  /** SCENARIO exams force every slot to the SCENARIO format regardless of cognitive level (spec §32). */
  forceScenario?: boolean;
}): Promise<ExamQuestion[]> {
  const baseDifficulty = typeof params.config.difficulty === "number" ? params.config.difficulty : 2;
  const created: ExamQuestion[] = [];
  let position = 1;

  for (const entry of params.blueprint.entries) {
    const levels = assignCognitiveLevels(entry.questionCount, entry.cognitiveDistribution as Record<CognitiveLevelValue, number>);
    const difficulty = difficultyForTier(baseDifficulty, entry.tier);

    for (const cognitiveLevel of levels) {
      const questionType = params.forceScenario ? "SCENARIO" : questionTypeForCognitiveLevel(cognitiveLevel);
      const question = await getOrGenerateExamQuestion({
        examId: params.examId,
        courseId: params.courseId,
        conceptId: entry.conceptId,
        questionType,
        cognitiveLevel,
        difficulty,
        position,
        userId: params.userId,
        excludeQuestionIds: created.map((q) => q.id),
      });
      if (question) {
        created.push(question);
        position += 1;
      }
    }
  }

  return created;
}
