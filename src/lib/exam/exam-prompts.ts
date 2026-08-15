import {
  AnswerGradingSchema,
  ExamQuestionGenerationSchema,
  OralExaminerMessageSchema,
  type CognitiveLevelValue,
  type ExamQuestionTypeValue,
} from "./types";

/**
 * Prompt builders for every Claude call the exam engine makes. Each pairs
 * with a Zod schema from types.ts (spec §59) and is context-trimmed (spec
 * §61 — question, expected concepts, rubric, relevant source chunks,
 * student's answer; never the whole course).
 */

// ---------------------------------------------------------------------------
// Question generation (spec §7-9)
// ---------------------------------------------------------------------------

const TYPE_GUIDANCE: Record<ExamQuestionTypeValue, string> = {
  MULTIPLE_CHOICE: "Write 4 options with exactly one correct. Distractors must be plausible, grounded in the material (not absurd), and each wrong for a specific, identifiable reason.",
  MULTI_SELECT: "Write 4-5 options where 2 or more are correct. Every option must be independently gradable as true or false against the material.",
  TRUE_FALSE: "Write exactly 2 options: 'True' and 'False'. The statement must be unambiguous and decidable from the material alone.",
  SHORT_ANSWER: "The student must retrieve a specific fact, term, or short phrase directly from memory. No options — free text.",
  OPEN_ENDED: "Ask the student to explain a mechanism, process, or relationship in their own words. Free text, evaluated against a rubric.",
  PROBLEM_SOLVING: "Present a concrete problem requiring the student to work through steps or apply a procedure to reach an answer. Free text.",
  SCENARIO: "Build a realistic situational scenario (context/objective/constraints/available information) and ask the student to reason about what they'd do or investigate. Evaluate reasoning and prioritization, not one exact wording.",
  TEACH_BACK: "Ask the student to explain the concept as if teaching someone new to it. Free text, evaluated for correctness and completeness.",
};

const COGNITIVE_GUIDANCE: Record<CognitiveLevelValue, string> = {
  RECALL: "Tests direct retrieval of a fact or definition.",
  UNDERSTAND: "Tests explaining a mechanism or relationship in the student's own words.",
  APPLY: "Tests using the concept in a concrete situation not verbatim from the source material.",
  ANALYZE: "Tests breaking a situation down, comparing options, or identifying the relevant factor among several.",
  EVALUATE: "Tests judging between approaches or justifying a decision using the concept.",
};

const SYSTEM_PROMPT = `You are an exam-question writer creating one assessment question strictly grounded in the provided course material.

Hard rules:
- Use ONLY the concept description and source chunks given below. Never invent course-specific facts, numbers, or terminology not actually in the material.
- The question must be answerable from the provided material alone, at the requested cognitive level and difficulty.
- Cite the chunkId(s) the question and expected answer actually draw from in sourceChunkIds. Do not cite a chunk you didn't use.
- If the material doesn't support a good, grounded question of the requested type/cognitive level/difficulty, set canGenerate to false with a short refusalReason instead of forcing a weak question.
- For MULTIPLE_CHOICE/MULTI_SELECT/TRUE_FALSE: populate options and correctOptionIds; never populate expectedAnswer/rubric for these types.
- For SHORT_ANSWER/OPEN_ENDED/PROBLEM_SOLVING/TEACH_BACK: populate expectedAnswer and a 2-5 item rubric of short, checkable criteria; never populate options.
- For SCENARIO: populate the scenario object (context/objective/constraints/availableInformation) plus a rubric describing what good reasoning covers; prompt should be the actual question being asked about the scenario.
- Avoid trivial rewordings of any "recently asked" questions listed below — write something meaningfully different (new wording, new example, or new scenario).
- Return structured JSON only, matching the provided schema.`;

export interface ExamQuestionGenerationContext {
  courseTitle: string;
  conceptName: string;
  conceptDescription: string;
  sourceChunks: Array<{ id: string; text: string }>;
  questionType: ExamQuestionTypeValue;
  cognitiveLevel: CognitiveLevelValue;
  difficulty: number;
  prerequisiteContext?: string[];
  recentPrompts?: string[];
}

export function buildExamQuestionGenerationPrompt(ctx: ExamQuestionGenerationContext) {
  const chunkBlocks = ctx.sourceChunks.map((chunk) => `Chunk ${chunk.id}:\n"""\n${chunk.text}\n"""`).join("\n\n");

  const sections: string[] = [
    `Course: ${ctx.courseTitle}`,
    `Concept: ${ctx.conceptName}`,
    `Concept description: ${ctx.conceptDescription}`,
    `Question format: ${ctx.questionType} — ${TYPE_GUIDANCE[ctx.questionType]}`,
    `Cognitive level: ${ctx.cognitiveLevel} — ${COGNITIVE_GUIDANCE[ctx.cognitiveLevel]}`,
    `Target difficulty: ${ctx.difficulty}/5 (1 = very easy, 5 = very difficult)`,
    `Source material:\n${chunkBlocks}`,
  ];

  if (ctx.prerequisiteContext && ctx.prerequisiteContext.length > 0) {
    sections.push(`Known prerequisites of this concept: ${ctx.prerequisiteContext.join(", ")}`);
  }
  if (ctx.recentPrompts && ctx.recentPrompts.length > 0) {
    sections.push(`Recently asked questions on this concept (write something different):\n${ctx.recentPrompts.map((p) => `- ${p}`).join("\n")}`);
  }

  sections.push("Write one question according to the format, cognitive level, difficulty, and grounding requirements above.");

  return { system: SYSTEM_PROMPT, prompt: sections.join("\n\n"), schema: ExamQuestionGenerationSchema };
}

// ---------------------------------------------------------------------------
// Answer grading (spec §20-23) — used for every non-auto-graded type.
// ---------------------------------------------------------------------------

const GRADING_SYSTEM_PROMPT = `You are grading one exam answer, strictly and fairly, against the provided rubric and source material — this is a formal assessment, not a tutoring conversation.

Rules:
- classification is CORRECT, PARTIALLY_CORRECT, INCORRECT, MISCONCEPTION, or UNANSWERED — never a boolean. Use UNANSWERED only if the answer is empty or a non-attempt.
- Use MISCONCEPTION only when the answer reveals a specific, identifiable WRONG belief (not just an incomplete or vague answer).
- Score each of the five criteria (correctness, completeness, reasoning, application, conceptualUnderstanding) independently 0-1. A criterion that doesn't apply to this question type (e.g. "application" for a pure definition question) should still get a score reflecting whether the answer would generalize, not be left low by default.
- These are your only outputs for scoring — do NOT compute or state an overall/final score; the application calculates that from your criteria.
- missingConcepts are short phrases (not sentences) naming specific ideas the answer should have included but didn't.
- misconceptions lists specific wrong beliefs revealed by the answer — leave empty if none, never invent one. Set severity only when misconceptions is non-empty.
- feedback is 1-3 short sentences addressed to the student, usable directly — no meta-commentary about your grading process, no hidden reasoning.
- Base every judgment only on the question, rubric, source material, and the student's answer given below.
- Return structured JSON only, matching the provided schema.`;

export interface AnswerGradingContext {
  conceptName: string;
  questionPrompt: string;
  questionType: string;
  scenario?: { context: string; objective: string; constraints: string[]; availableInformation: string[] } | null;
  expectedAnswer: string | null;
  rubric: string[];
  sourceChunks: Array<{ id: string; text: string }>;
  studentAnswer: string;
}

export function buildAnswerGradingPrompt(ctx: AnswerGradingContext) {
  const chunkBlocks = ctx.sourceChunks.map((chunk) => `Chunk ${chunk.id}:\n"""\n${chunk.text}\n"""`).join("\n\n");

  const sections: string[] = [`Concept: ${ctx.conceptName}`, `Question type: ${ctx.questionType}`];

  if (ctx.scenario) {
    sections.push(
      `Scenario context: ${ctx.scenario.context}`,
      `Objective: ${ctx.scenario.objective}`,
      `Constraints: ${ctx.scenario.constraints.join("; ") || "(none)"}`,
      `Available information: ${ctx.scenario.availableInformation.join("; ") || "(none)"}`,
    );
  }

  sections.push(`Question: ${ctx.questionPrompt}`);
  if (ctx.expectedAnswer) sections.push(`Reference answer (not the only acceptable phrasing): ${ctx.expectedAnswer}`);
  if (ctx.rubric.length > 0) sections.push(`Rubric criteria:\n${ctx.rubric.map((r) => `- ${r}`).join("\n")}`);
  if (ctx.sourceChunks.length > 0) sections.push(`Source material:\n${chunkBlocks}`);
  sections.push(`Student's answer:\n"""\n${ctx.studentAnswer || "(no answer submitted)"}\n"""`);
  sections.push("Grade this answer according to the rules above.");

  return { system: GRADING_SYSTEM_PROMPT, prompt: sections.join("\n\n"), schema: AnswerGradingSchema };
}

// ---------------------------------------------------------------------------
// Oral exam examiner messages (spec §28-31)
// ---------------------------------------------------------------------------

const ORAL_SYSTEM_PROMPT = `You are a real oral exam examiner. Your job is to test whether the student truly understands the material — not to teach.

Rules (never break these):
- Ask exactly ONE question at a time.
- Never give a teaching explanation, hint, or the answer, at any point during the exam.
- Build directly on the student's previous answer: challenge it, ask them to clarify, probe deeper, ask "why?" or "how?", ask for an example, or test an edge case — whichever fits the depth level given below.
- Match the requested depth: level 1 = definition, level 2 = explanation of mechanism, level 3 = application to a concrete case, level 4 = an edge case or complication, level 5 = expert-level reasoning connecting multiple ideas.
- One or two short sentences. No preamble, no praise before the next question.
- Return structured JSON only, matching the provided schema.`;

export interface OralExaminerContext {
  conceptName: string;
  conceptDescription: string;
  depth: number;
  conversationHistory: Array<{ role: string; content: string }>;
}

export function buildOralExaminerPrompt(ctx: OralExaminerContext) {
  const history =
    ctx.conversationHistory.length > 0
      ? ctx.conversationHistory.map((t) => `${t.role}: ${t.content}`).join("\n")
      : "(exam just started — this is the opening question)";

  const sections = [
    `Concept being examined: ${ctx.conceptName}`,
    `Concept description: ${ctx.conceptDescription}`,
    `Current depth level: ${ctx.depth}`,
    `Conversation so far:\n${history}`,
    "Ask the next examiner question according to the rules above.",
  ];

  return { system: ORAL_SYSTEM_PROMPT, prompt: sections.join("\n\n"), schema: OralExaminerMessageSchema };
}
