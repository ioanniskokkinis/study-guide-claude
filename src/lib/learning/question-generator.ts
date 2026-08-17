import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { extractStructured } from "@/lib/ai/claude";
import { withRetry } from "@/lib/ai/retry";
import { AI_MAX_TOKENS } from "@/lib/ai/token-budgets";
import { AI_TIMEOUT_MS } from "@/lib/ai/timeout-budgets";
import {
  buildQuestionGenerationPrompt,
  QuestionGenerationSchema,
  type QuestionGenerationTypeSchema,
} from "@/lib/ai/prompts/question-generation";
import { getConceptMistakes, getMastery, describeMasteryStatus } from "@/lib/services/student-knowledge";
import type { Question } from "@/generated/prisma/client";
import type { z } from "zod";

export type GeneratedQuestionType = z.infer<typeof QuestionGenerationTypeSchema>;

const SOURCE_CHUNKS_PER_QUESTION = 5;
const RECENT_PROMPTS_TO_AVOID = 5;
const RECENT_MISTAKES_FOR_CONTEXT = 3;
const DUPLICATE_JACCARD_THRESHOLD = 0.85;
const MAX_GENERATION_ATTEMPTS = 2;

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
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Duplicate detection (spec §24): exact normalized-prompt match, plus a
 * cheap token-overlap heuristic for near-duplicates. Deliberately not
 * embedding-based yet — the architecture (a single predicate function) is
 * easy to swap for a semantic check later without touching callers.
 */
async function isDuplicateQuestion(conceptId: string, prompt: string): Promise<boolean> {
  const normalized = normalizePrompt(prompt);
  const existing = await prisma.question.findMany({
    where: { conceptId },
    select: { prompt: true, normalizedPrompt: true },
  });

  const candidateTokens = tokenSet(normalized);
  return existing.some((q) => {
    if (q.normalizedPrompt === normalized) return true;
    return jaccardSimilarity(candidateTokens, tokenSet(q.normalizedPrompt)) >= DUPLICATE_JACCARD_THRESHOLD;
  });
}

async function findReusableQuestion(
  conceptId: string,
  type: GeneratedQuestionType,
  difficulty: number,
  excludeQuestionIds: string[],
): Promise<Question | null> {
  return prisma.question.findFirst({
    where: {
      conceptId,
      type,
      difficulty,
      ...(excludeQuestionIds.length > 0 ? { id: { notIn: excludeQuestionIds } } : {}),
    },
    // Oldest first: a rough stand-in for "reuse the one asked longest ago" without a dedicated lastUsedAt column.
    orderBy: { createdAt: "asc" },
  });
}

async function getDirectPrerequisiteNames(conceptId: string): Promise<string[]> {
  const edges = await prisma.conceptRelationship.findMany({
    where: { relationshipType: "prerequisite", targetConceptId: conceptId },
    select: { sourceConcept: { select: { name: true } } },
  });
  return edges.map((e) => e.sourceConcept.name);
}

export interface GenerateQuestionParams {
  courseId: string;
  conceptId: string;
  type: GeneratedQuestionType;
  difficulty: number;
  userId: string;
  /** Tags the AiUsageLog request type — REMEDIATION for retry/focused questions, ACTIVE_RECALL_QUESTION_PREFETCH for background buffer top-ups, QUESTION_GENERATION otherwise (spec §28/§34). */
  purpose?: "QUESTION_GENERATION" | "REMEDIATION" | "ACTIVE_RECALL_QUESTION_PREFETCH";
  /** Question ids already shown in the current session — never reused within it (spec §24). */
  excludeQuestionIds?: string[];
}

/**
 * Reuse-before-generate (spec §23): looks for an existing, unused-in-this-
 * session Question at the right concept/type/difficulty first, and only
 * calls Claude if nothing suitable exists. Returns null if generation isn't
 * possible — either Claude refused (source material too thin, spec §6) or
 * every attempt produced a duplicate/ungrounded question; callers should
 * fall back to a different concept/type/difficulty rather than treat this
 * as a hard error.
 */
export async function getOrGenerateQuestion(params: GenerateQuestionParams): Promise<Question | null> {
  const excludeQuestionIds = params.excludeQuestionIds ?? [];

  const reusable = await findReusableQuestion(params.conceptId, params.type, params.difficulty, excludeQuestionIds);
  if (reusable) return reusable;

  const concept = await prisma.concept.findFirst({
    where: { id: params.conceptId, courseId: params.courseId },
    select: { id: true, name: true, description: true, course: { select: { title: true } } },
  });
  if (!concept) return null;

  const sources = await prisma.conceptSource.findMany({
    where: { conceptId: params.conceptId },
    orderBy: { relevance: "desc" },
    take: SOURCE_CHUNKS_PER_QUESTION,
    select: { documentChunk: { select: { id: true, text: true } } },
  });
  if (sources.length === 0) {
    // No traceable source material for this concept — refuse rather than let Claude invent facts (spec §6).
    return null;
  }
  const sourceChunks = sources.map((s) => ({ id: s.documentChunk.id, text: s.documentChunk.text }));
  const knownChunkIds = new Set(sourceChunks.map((c) => c.id));

  const [prerequisiteNames, mastery, mistakes, recentQuestions] = await Promise.all([
    getDirectPrerequisiteNames(params.conceptId),
    getMastery(params.userId, params.conceptId),
    getConceptMistakes(params.userId, params.conceptId, { limit: RECENT_MISTAKES_FOR_CONTEXT }),
    prisma.question.findMany({
      where: { conceptId: params.conceptId },
      orderBy: { createdAt: "desc" },
      take: RECENT_PROMPTS_TO_AVOID,
      select: { prompt: true },
    }),
  ]);

  const recentPrompts = recentQuestions.map((q) => q.prompt);

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const { system, prompt } = buildQuestionGenerationPrompt({
      courseTitle: concept.course.title,
      conceptName: concept.name,
      conceptDescription: concept.description ?? "(no description recorded)",
      sourceChunks,
      type: params.type,
      difficulty: params.difficulty,
      prerequisiteContext: prerequisiteNames,
      studentMasteryNote: mastery ? describeMasteryStatus(mastery.status) : undefined,
      recentMistakeNotes: mistakes?.map((m) => m.description),
      recentPrompts,
    });

    const { data } = await withRetry(() =>
      extractStructured({
        model: env.AI_MODEL_QUESTION_GENERATION,
        system,
        prompt,
        schema: QuestionGenerationSchema,
        maxTokens: AI_MAX_TOKENS.EXAM,
        requestType: params.purpose ?? "QUESTION_GENERATION",
        userId: params.userId,
        timeoutMs: AI_TIMEOUT_MS.QUESTION_GENERATION,
      }),
    );

    if (!data.canGenerate || !data.prompt || !data.expectedAnswer || !data.rubric?.length || !data.sourceChunkIds?.length) {
      continue;
    }

    // Never trust cited chunk ids outright — drop any that weren't actually in the batch given.
    const groundedChunkIds = data.sourceChunkIds.filter((id) => knownChunkIds.has(id));
    if (groundedChunkIds.length === 0) {
      continue;
    }

    if (await isDuplicateQuestion(params.conceptId, data.prompt)) {
      recentPrompts.push(data.prompt);
      continue;
    }

    return prisma.question.create({
      data: {
        courseId: params.courseId,
        conceptId: params.conceptId,
        type: params.type,
        difficulty: params.difficulty,
        prompt: data.prompt,
        normalizedPrompt: normalizePrompt(data.prompt),
        expectedAnswer: data.expectedAnswer,
        rubric: data.rubric,
        sourceReferences: groundedChunkIds,
      },
    });
  }

  return null;
}
