import {
  ExplanationContentSchema,
  ResponseEvaluationSchema,
  SocraticMessageSchema,
  TeachBackEvaluationSchema,
} from "./types";

/**
 * Prompt builders for every Claude call the tutor makes. Every function
 * here returns `{ system, prompt }` and pairs with a Zod schema from
 * types.ts — never a free-text call (spec §35). Context is deliberately
 * trimmed to what's relevant to this concept and this turn (spec §36):
 * concept, a short conversation window, recent mistakes, and — only for
 * explanations — a couple of source chunks, never the whole course.
 */

export interface ConceptFacts {
  conceptName: string;
  conceptDescription: string | null;
  masteryBucket: "unknown" | "weak" | "developing" | "strong";
  recentMistakeDescriptions: string[];
  conversationHistory: Array<{ role: string; content: string }>;
}

function conversationBlock(history: ConceptFacts["conversationHistory"]): string {
  if (history.length === 0) return "(no prior conversation this session)";
  return history.map((turn) => `${turn.role}: ${turn.content}`).join("\n");
}

function conceptBlock(ctx: ConceptFacts): string[] {
  const lines = [
    `Concept: ${ctx.conceptName}`,
    `Concept description: ${ctx.conceptDescription ?? "(no description recorded)"}`,
    `Student's current mastery level: ${ctx.masteryBucket}`,
  ];
  if (ctx.recentMistakeDescriptions.length > 0) {
    lines.push(`Recent unresolved mistakes on this concept:\n${ctx.recentMistakeDescriptions.map((m) => `- ${m}`).join("\n")}`);
  }
  lines.push(`Recent conversation:\n${conversationBlock(ctx.conversationHistory)}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Response evaluation — classifies the student's latest free-text turn.
// ---------------------------------------------------------------------------

const RESPONSE_EVALUATION_SYSTEM = `You are evaluating a student's spoken response during a live tutoring conversation, not grading a formal exam answer.

Rules:
- classification is CORRECT, PARTIALLY_CORRECT, INCORRECT, MISCONCEPTION, or UNKNOWN — never a boolean.
- Use MISCONCEPTION only when the response reveals a specific, identifiable WRONG belief (not just an incomplete or vague answer — that's INCORRECT or PARTIALLY_CORRECT).
- Use UNKNOWN when the response doesn't actually attempt to answer (off-topic, asks a question back, non-answer) — not for a wrong attempt.
- confidence is your own 0-1 confidence in this classification, not the student's.
- missingConcepts lists specific ideas the response should have included but didn't — short phrases, not sentences.
- recommendedAction is your suggestion only; the application decides the actual next step independently.
- feedback is 1-3 short sentences, addressed to the student, that could be shown directly — no meta-commentary about your evaluation process.
- Base every judgment only on the concept, conversation, and response given below.
- Return structured JSON only, matching the provided schema.`;

export interface ResponseEvaluationContext extends ConceptFacts {
  tutorPrompt: string;
  studentResponse: string;
}

export function buildResponseEvaluationPrompt(ctx: ResponseEvaluationContext) {
  const sections = [
    ...conceptBlock(ctx),
    `Tutor just asked: ${ctx.tutorPrompt}`,
    `Student responded:\n"""\n${ctx.studentResponse}\n"""`,
    "Classify this response according to the rules above.",
  ];
  return { system: RESPONSE_EVALUATION_SYSTEM, prompt: sections.join("\n\n"), schema: ResponseEvaluationSchema };
}

// ---------------------------------------------------------------------------
// Socratic question / follow-up generation.
// ---------------------------------------------------------------------------

const SOCRATIC_MESSAGE_SYSTEM = `You are a Socratic tutor. Your job is to help the student reach an answer themselves, never to state it for them.

Rules (never break these):
- Ask exactly ONE question. Never ask two questions in one message.
- Never give a large explanation — one or two short sentences at most before the question, if any lead-in is needed at all.
- Never reveal the answer, a near-synonym of it, or a fact that makes the question trivial.
- Build directly on the most recent exchange in the conversation — do not repeat a question already asked.
- Match the question's depth to the given intent (a fresh question, a narrowing follow-up, a deeper transfer question, or a simplified restatement) — follow the intent given below exactly.
- Return structured JSON only, matching the provided schema.`;

export interface SocraticMessageContext extends ConceptFacts {
  intent: "new_question" | "followup" | "deepen" | "simplify";
  difficulty: number;
}

export function buildSocraticMessagePrompt(ctx: SocraticMessageContext) {
  const intentInstruction: Record<SocraticMessageContext["intent"], string> = {
    new_question: "Ask an opening question on this concept, calibrated to the difficulty level given.",
    followup: "Ask a targeted follow-up question that narrows in on what the student's last response was missing or got partially right.",
    deepen: "Ask a deeper, transfer-style question that asks the student to apply or extend the concept in a new situation.",
    simplify: "Ask a simpler, more concrete version of the question — break it into a smaller first step.",
  };

  const sections = [
    ...conceptBlock(ctx),
    `Target difficulty (1=easiest, 5=hardest): ${ctx.difficulty}`,
    `Intent: ${intentInstruction[ctx.intent]}`,
    "Write the tutor's next message according to the rules above.",
  ];
  return { system: SOCRATIC_MESSAGE_SYSTEM, prompt: sections.join("\n\n"), schema: SocraticMessageSchema };
}

// ---------------------------------------------------------------------------
// Explanation generation (GIVE_EXPLANATION).
// ---------------------------------------------------------------------------

const EXPLANATION_SYSTEM = `You are giving a short, targeted explanation of one specific concept the student is struggling with — not a textbook chapter.

Structure your explanation into exactly four parts (spec-required):
1. coreIdea — the single most important idea, in 1-2 sentences.
2. example — one concrete example illustrating it.
3. connection — one sentence connecting it back to the concept currently being studied.
4. checkQuestion — one small retrieval question the student should answer next to prove they got it (never end an explanation with just "do you understand?").

Adapt tone and depth to the student's mastery level given below: beginner = simple language and analogy; intermediate = technical explanation with examples; advanced = edge cases and trade-offs.

Use the given explanation strategy (analogy, example, counterexample, step-by-step, or compare/contrast) as the primary teaching device — do not default to the same style every time.

Ground every fact in the provided source material where given; never invent course-specific facts not supported by it.

Return structured JSON only, matching the provided schema.`;

export interface ExplanationContext extends ConceptFacts {
  strategy: string;
  sourceChunks: Array<{ citation: string; text: string }>;
}

export function buildExplanationPrompt(ctx: ExplanationContext) {
  const sections = [...conceptBlock(ctx), `Explanation strategy to use: ${ctx.strategy}`];

  if (ctx.sourceChunks.length > 0) {
    sections.push(
      `Source material:\n${ctx.sourceChunks.map((c) => `[${c.citation}]\n"""\n${c.text}\n"""`).join("\n\n")}`,
    );
  }

  sections.push("Write the explanation according to the structure and rules above.");
  return { system: EXPLANATION_SYSTEM, prompt: sections.join("\n\n"), schema: ExplanationContentSchema };
}

// ---------------------------------------------------------------------------
// Progressive hints.
// ---------------------------------------------------------------------------

const HINT_SYSTEM = `You are giving a progressive study hint. The student is trying to retrieve the answer from memory — your job is to nudge them, not teach or answer for them.

Rules by level (never skip ahead of the given level):
- HINT_1: point at the general area or category to think about — very indirect.
- HINT_2: narrow it down — name a relevant factor or distinction to consider, still without stating the answer.
- HINT_3: give a strong, specific nudge — close to the answer's shape, but still requiring the student to make the final connection themselves.
- Never state the answer, a synonym close enough to be the answer, or a fact that makes the question trivial to answer, at any level.
- One or two short sentences. No preamble.
- Return structured JSON only, matching the provided schema.`;

export interface HintContext extends ConceptFacts {
  level: 1 | 2 | 3;
  tutorPrompt: string;
}

export function buildHintPrompt(ctx: HintContext) {
  const sections = [
    ...conceptBlock(ctx),
    `Current question: ${ctx.tutorPrompt}`,
    `Hint level to give: HINT_${ctx.level}`,
    "Write the hint according to the rules above.",
  ];
  return { system: HINT_SYSTEM, prompt: sections.join("\n\n"), schema: SocraticMessageSchema };
}

// ---------------------------------------------------------------------------
// Teach-back evaluation.
// ---------------------------------------------------------------------------

const TEACH_BACK_EVALUATION_SYSTEM = `You are evaluating a student's attempt to explain a concept in their own words, as if teaching it to a beginner.

Rules:
- overall is CORRECT, PARTIALLY_CORRECT, or INCORRECT.
- correctElements/missingElements are short phrases (not sentences) naming specific ideas the explanation got right or left out.
- misconceptions lists specific wrong beliefs the explanation reveals — leave empty if there are none, do not invent one.
- correctness/completeness/conceptualAccuracy are each an independent 0-1 score:
  - correctness: how accurate is what was said (ignoring what was left out)?
  - completeness: how much of the concept's key ideas were covered?
  - conceptualAccuracy: does the underlying mental model seem right, even if wording is imprecise?
- suggestedFollowup is one short, concrete next question or prompt.
- Base every judgment only on the concept and the student's explanation given below.
- Return structured JSON only, matching the provided schema.`;

export interface TeachBackEvaluationContext extends ConceptFacts {
  studentExplanation: string;
}

export function buildTeachBackEvaluationPrompt(ctx: TeachBackEvaluationContext) {
  const sections = [
    ...conceptBlock(ctx),
    `Student's explanation:\n"""\n${ctx.studentExplanation}\n"""`,
    "Evaluate the explanation according to the rules above.",
  ];
  return { system: TEACH_BACK_EVALUATION_SYSTEM, prompt: sections.join("\n\n"), schema: TeachBackEvaluationSchema };
}

/**
 * The teach-back prompt itself is a fixed template, not a Claude call (spec
 * §53 — no AI needed for mechanical text that doesn't require language
 * intelligence).
 */
export function teachBackPromptText(conceptName: string): string {
  return `Explain "${conceptName}" in your own words, as if you were teaching it to someone who has never heard of it before.`;
}
