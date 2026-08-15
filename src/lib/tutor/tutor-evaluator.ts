import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { extractStructured } from "@/lib/ai/claude";
import { withRetry } from "@/lib/ai/retry";
import {
  buildExplanationPrompt,
  buildHintPrompt,
  buildResponseEvaluationPrompt,
  buildSocraticMessagePrompt,
  buildTeachBackEvaluationPrompt,
  type ConceptFacts,
} from "./tutor-prompts";
import { ExplanationContentSchema, ResponseEvaluationSchema, TeachBackEvaluationSchema, type ExplanationContent, type ResponseEvaluation, type TeachBackEvaluation } from "./types";

/**
 * Every Claude call the tutor makes, plus the deterministic pieces that
 * deliberately don't need one (spec §53): explicit-phrase detection for "I
 * don't know" / "just tell me" runs first and short-circuits before any AI
 * call. Every generation function has a deterministic fallback (spec §55)
 * so a Claude failure degrades the conversation instead of destroying the
 * session — the caller never sees a thrown API error.
 */

const DONT_KNOW_PATTERNS = [
  /^i\s*don'?t\s*know$/i,
  /^not\s*sure$/i,
  /^no\s*idea$/i,
  /^idk$/i,
  /^i\s*have\s*no\s*idea$/i,
  /^i'?m\s*not\s*sure$/i,
];

const REVEAL_REQUEST_PATTERNS = [
  /just\s*tell\s*me/i,
  /^(give|show)\s*me\s*the\s*answer/i,
  /^what'?s\s*the\s*answer/i,
  /^tell\s*me\s*the\s*answer/i,
  /^i\s*give\s*up/i,
];

/** Deterministic, zero-cost detection (spec §45, §53) — only falls through to the evaluator when the phrase doesn't clearly match. */
export function detectExplicitDontKnow(text: string): boolean {
  const trimmed = text.trim();
  return DONT_KNOW_PATTERNS.some((p) => p.test(trimmed));
}

export function detectExplicitRevealRequest(text: string): boolean {
  return REVEAL_REQUEST_PATTERNS.some((p) => p.test(text.trim()));
}

function fallbackResponseEvaluation(): ResponseEvaluation {
  return {
    classification: "UNKNOWN",
    confidence: 0,
    misconceptionDescription: null,
    severity: null,
    missingConcepts: [],
    recommendedAction: "ASK_FOLLOWUP",
    feedback: "Let's try another approach.",
  };
}

export async function evaluateStudentResponse(
  ctx: ConceptFacts & { tutorPrompt: string; studentResponse: string; userId?: string | null },
): Promise<ResponseEvaluation> {
  const { system, prompt, schema } = buildResponseEvaluationPrompt(ctx);
  try {
    const { data } = await withRetry(() =>
      extractStructured({
        model: env.AI_MODEL_TUTOR_EVALUATION,
        system,
        prompt,
        schema,
        requestType: "TUTOR_RESPONSE_EVALUATION",
        userId: ctx.userId,
      }),
    );
    return ResponseEvaluationSchema.parse(data);
  } catch {
    return fallbackResponseEvaluation();
  }
}

function fallbackSocraticMessage(conceptName: string, intent: string): string {
  if (intent === "deepen") return `Can you apply ${conceptName} to a new situation you haven't seen before?`;
  if (intent === "simplify") return `Let's take a smaller step — what's the very first thing that comes to mind about ${conceptName}?`;
  return `Let's try another approach — what do you already know about ${conceptName}?`;
}

export async function generateSocraticMessage(
  ctx: ConceptFacts & { intent: "new_question" | "followup" | "deepen" | "simplify"; difficulty: number; userId?: string | null },
): Promise<string> {
  const { system, prompt, schema } = buildSocraticMessagePrompt(ctx);
  try {
    const { data } = await withRetry(() =>
      extractStructured({
        model: env.AI_MODEL_TUTOR_GENERATION,
        system,
        prompt,
        schema,
        requestType: "TUTOR_SOCRATIC_MESSAGE",
        userId: ctx.userId,
      }),
    );
    return data.message;
  } catch {
    return fallbackSocraticMessage(ctx.conceptName, ctx.intent);
  }
}

function fallbackHint(conceptName: string, level: 1 | 2 | 3): string {
  if (level === 1) return `Think about what ${conceptName} is fundamentally trying to solve.`;
  if (level === 2) return `Consider the specific mechanism ${conceptName} relies on.`;
  return `You're close — focus on the key detail that distinguishes ${conceptName} from similar ideas.`;
}

export async function generateHint(
  ctx: ConceptFacts & { level: 1 | 2 | 3; tutorPrompt: string; userId?: string | null },
): Promise<string> {
  const { system, prompt, schema } = buildHintPrompt(ctx);
  try {
    const { data } = await withRetry(() =>
      extractStructured({
        model: env.AI_MODEL_TUTOR_GENERATION,
        system,
        prompt,
        schema,
        requestType: "TUTOR_HINT",
        userId: ctx.userId,
      }),
    );
    return data.message;
  } catch {
    return fallbackHint(ctx.conceptName, ctx.level);
  }
}

function fallbackExplanation(ctx: ConceptFacts): ExplanationContent {
  return {
    coreIdea: ctx.conceptDescription ?? `${ctx.conceptName} is a concept in this course worth reviewing carefully.`,
    example: `Think of a situation where ${ctx.conceptName} would come up in practice.`,
    connection: `This connects back to what you're currently studying.`,
    checkQuestion: `In your own words, what is the main idea behind ${ctx.conceptName}?`,
  };
}

export async function generateExplanation(
  ctx: ConceptFacts & { strategy: string; sourceChunks: Array<{ citation: string; text: string }>; userId?: string | null },
): Promise<ExplanationContent> {
  const { system, prompt, schema } = buildExplanationPrompt(ctx);
  try {
    const { data } = await withRetry(() =>
      extractStructured({
        model: env.AI_MODEL_TUTOR_GENERATION,
        system,
        prompt,
        schema,
        requestType: "TUTOR_EXPLANATION",
        userId: ctx.userId,
      }),
    );
    return ExplanationContentSchema.parse(data);
  } catch {
    return fallbackExplanation(ctx);
  }
}

function fallbackTeachBackEvaluation(): TeachBackEvaluation {
  return {
    overall: "PARTIALLY_CORRECT",
    correctElements: [],
    missingElements: [],
    misconceptions: [],
    correctness: 0.5,
    completeness: 0.5,
    conceptualAccuracy: 0.5,
    suggestedFollowup: "Can you say a bit more about how this works?",
  };
}

export async function evaluateTeachBack(
  ctx: ConceptFacts & { studentExplanation: string; userId?: string | null },
): Promise<TeachBackEvaluation> {
  const { system, prompt, schema } = buildTeachBackEvaluationPrompt(ctx);
  try {
    const { data } = await withRetry(() =>
      extractStructured({
        model: env.AI_MODEL_TUTOR_EVALUATION,
        system,
        prompt,
        schema,
        requestType: "TUTOR_TEACH_BACK_EVALUATION",
        userId: ctx.userId,
      }),
    );
    return TeachBackEvaluationSchema.parse(data);
  } catch {
    return fallbackTeachBackEvaluation();
  }
}

/** A couple of source chunks for grounding an explanation (spec §37-38) — never the whole document. */
export async function resolveSourceCitations(
  conceptId: string,
  limit = 2,
): Promise<Array<{ citation: string; text: string }>> {
  const sources = await prisma.conceptSource.findMany({
    where: { conceptId },
    orderBy: { relevance: "desc" },
    take: limit,
    select: {
      documentChunk: {
        select: { text: true, chunkIndex: true, document: { select: { originalFilename: true } } },
      },
    },
  });

  return sources.map((s) => ({
    citation: `${s.documentChunk.document.originalFilename} (section ${s.documentChunk.chunkIndex + 1})`,
    text: s.documentChunk.text,
  }));
}
