import { prisma } from "@/lib/db/prisma";
import type { Exam, ExamAnswer, ExamQuestion, LearningActivityType, MistakeSeverity, Prisma } from "@/generated/prisma/client";
import { getCourseMastery } from "@/lib/services/student-knowledge";
import { getStudentLearningState } from "@/lib/learning/adaptive/student-state";
import { recordLearningOutcome, type MistakeInput } from "@/lib/learning/record-outcome";
import { buildExamBlueprint } from "./exam-blueprint";
import { generateExamFromBlueprint, getOrGenerateExamQuestion } from "./exam-generator";
import { nextAdaptiveStep, planAdaptiveSequence, type LastAdaptiveAnswer } from "./adaptive-exam";
import { cognitiveLevelForDepth, nextOralProgression } from "./oral-exam";
import { gradeExamAnswer, generateOralExaminerMessage } from "./exam-evaluator";
import { evidenceScoreForExamAnswer, gradeFromRubric, gradeMultiSelect, gradeSingleSelect } from "./exam-grader";
import { calculateExamResult, identifyWeakConcepts, recommendNextAction } from "./exam-engine";
import { analyzeExamMistakes, toStudentMistakeCategory } from "./mistake-analyzer";
import { calculateReadiness } from "./exam-readiness";
import { computeRemainingSeconds, isExamTimeExpired } from "./exam-state";
import { AUTO_GRADED_TYPES, EXAM_MISTAKE_CATEGORIES, type ExamConfig, type ExamConfidenceLevelValue, type NextBestExamActionResult, type ReadinessOutput } from "./types";
import { DEFAULT_DURATION_MINUTES, DEFAULT_PASSING_SCORE, DEFAULT_QUESTION_COUNT, RETEST_QUESTION_COUNT } from "./config";
import type { ExamResultAggregate } from "./exam-engine";

/**
 * The full exam pipeline (spec §2, §64): create -> generate -> serve ->
 * grade -> diagnose -> record evidence -> calculate readiness ->
 * recommend. API routes call only the functions in this file; every
 * decision/scoring/diagnosis step itself lives in the smaller, independently
 * testable modules this file composes (exam-blueprint/-generator/-grader/
 * mistake-analyzer/exam-readiness/exam-engine/adaptive-exam/oral-exam).
 */

export class ExamNotFoundError extends Error {
  constructor() {
    super("Exam not found.");
  }
}

export class ExamNotActiveError extends Error {
  constructor() {
    super("This exam is not currently active.");
  }
}

export class NoConceptsAvailableError extends Error {
  constructor() {
    super("This course has no knowledge graph yet — build it before an exam can be created.");
  }
}

export class QuestionNotFoundError extends Error {
  constructor() {
    super("Question not found on this exam.");
  }
}

export class ExamGenerationFailedError extends Error {
  constructor() {
    super("Could not generate exam questions right now. Please try again.");
  }
}

function toActivityType(questionType: ExamQuestion["questionType"]): LearningActivityType {
  switch (questionType) {
    case "MULTIPLE_CHOICE":
    case "MULTI_SELECT":
    case "TRUE_FALSE":
    case "SHORT_ANSWER":
      return "RECALL";
    case "OPEN_ENDED":
      return "EXPLANATION";
    case "PROBLEM_SOLVING":
      return "APPLICATION";
    case "SCENARIO":
      return "SCENARIO";
    case "TEACH_BACK":
      return "TEACH_BACK";
  }
}

function confidenceToScore(level: ExamConfidenceLevelValue | null): number | null {
  switch (level) {
    case "CONFIDENT":
      return 0.9;
    case "UNSURE":
      return 0.5;
    case "GUESSING":
      return 0.15;
    default:
      return null;
  }
}

/** Never send grading internals (correct options, expected answer, rubric) or diagnostic metadata (difficulty, cognitive level) to the client while the exam is active (spec §8, §53). */
export function toStudentFacingQuestion(q: ExamQuestion) {
  return {
    id: q.id,
    position: q.position,
    questionType: q.questionType,
    prompt: q.prompt,
    options: Array.isArray(q.options) ? q.options : null,
    scenario: q.scenario ?? null,
    points: q.points,
  };
}

// ---------------------------------------------------------------------------
// Create / start
// ---------------------------------------------------------------------------

function conceptIdsKey(ids: unknown): string {
  return Array.isArray(ids) && ids.length > 0 ? [...(ids as string[])].sort().join(",") : "";
}

/**
 * Reuses an existing, not-yet-submitted exam with the identical request
 * shape instead of generating a new one (production-hardening phase §F/§G)
 * — the same student re-opening the same practice quiz resumes it rather
 * than paying for (and waiting on) a fresh Claude generation every time.
 * Once an exam is SUBMITTED/GRADED it's excluded, so "create" naturally
 * starts a fresh attempt after a previous one is actually finished.
 */
async function findReusableExam(config: ExamConfig): Promise<(Exam & { questions: ExamQuestion[] }) | null> {
  const baseDifficulty = typeof config.difficulty === "number" ? config.difficulty : 2;
  const candidates = await prisma.exam.findMany({
    where: {
      userId: config.userId,
      courseId: config.courseId,
      mode: config.mode,
      questionCount: config.questionCount,
      difficultyMode: config.difficulty === "ADAPTIVE" ? "ADAPTIVE" : "FIXED",
      status: { in: ["CREATED", "ACTIVE", "PAUSED"] },
    },
    orderBy: { createdAt: "desc" },
    include: { questions: true },
  });

  const wantedKey = conceptIdsKey(config.targetConceptIds);
  return (
    candidates.find(
      (exam) =>
        exam.questions.length > 0 &&
        (exam.difficultyMode !== "FIXED" || exam.difficulty === baseDifficulty) &&
        conceptIdsKey(exam.targetConceptIds) === wantedKey,
    ) ?? null
  );
}

export async function createExam(config: ExamConfig): Promise<Exam & { questions: ExamQuestion[] }> {
  const reusable = await findReusableExam(config);
  if (reusable) return reusable;

  const courseMastery = await getCourseMastery(config.userId, config.courseId);
  if (!courseMastery || courseMastery.concepts.length === 0) throw new NoConceptsAvailableError();

  const blueprint = buildExamBlueprint({ config, concepts: courseMastery.concepts });
  if (blueprint.entries.length === 0) throw new NoConceptsAvailableError();

  const baseDifficulty = typeof config.difficulty === "number" ? config.difficulty : 2;

  const exam = await prisma.exam.create({
    data: {
      userId: config.userId,
      courseId: config.courseId,
      mode: config.mode,
      difficultyMode: config.difficulty === "ADAPTIVE" ? "ADAPTIVE" : "FIXED",
      difficulty: baseDifficulty,
      questionCount: config.questionCount,
      timeLimitSeconds: config.durationMinutes > 0 ? config.durationMinutes * 60 : null,
      passingScore: config.passingScore,
      allowHints: config.allowHints,
      allowSources: config.allowSources,
      targetConceptIds: (config.targetConceptIds ?? null) as unknown as Prisma.InputJsonValue,
      blueprint: blueprint as unknown as Prisma.InputJsonValue,
      isRetest: config.isRetest ?? false,
    },
  });

  // Generation happens after the Exam row is created (unlike Phase 5's
  // getOrStartSession, which generates first specifically to avoid this) —
  // so on any failure below, the row must be cleaned up rather than left
  // behind as a permanently-empty, un-resumable CREATED exam (mirrors the
  // same "never leave an orphan behind" principle from Phase 5's fix).
  let questions: ExamQuestion[] = [];
  try {
    if (config.mode === "WRITTEN") {
      questions = await generateExamFromBlueprint({ examId: exam.id, courseId: config.courseId, blueprint, config, userId: config.userId });
    } else if (config.mode === "SCENARIO") {
      questions = await generateExamFromBlueprint({
        examId: exam.id,
        courseId: config.courseId,
        blueprint,
        config,
        userId: config.userId,
        forceScenario: true,
      });
    } else if (config.mode === "ADAPTIVE") {
      const plan = planAdaptiveSequence(blueprint);
      const first = plan[0];
      if (first) {
        const question = await getOrGenerateExamQuestion({
          examId: exam.id,
          courseId: config.courseId,
          conceptId: first.conceptId,
          questionType: "MULTIPLE_CHOICE",
          cognitiveLevel: first.cognitiveLevel,
          difficulty: baseDifficulty,
          position: 1,
          userId: config.userId,
        });
        if (question) questions = [question];
      }
    }
    // ORAL mode generates its opening question lazily in startExam() — no upfront generation to fail here.
  } catch (error) {
    await prisma.exam.delete({ where: { id: exam.id } });
    throw error;
  }

  if (questions.length === 0 && config.mode !== "ORAL") {
    await prisma.exam.delete({ where: { id: exam.id } });
    throw new ExamGenerationFailedError();
  }

  return { ...exam, questions };
}

async function loadOwnedExam(examId: string, userId: string): Promise<Exam | null> {
  return prisma.exam.findFirst({ where: { id: examId, userId } });
}

export async function startExam(examId: string, userId: string): Promise<{ exam: Exam; question: ExamQuestion | null }> {
  const exam = await loadOwnedExam(examId, userId);
  if (!exam) throw new ExamNotFoundError();

  if (exam.status === "ACTIVE") {
    const current = await prisma.examQuestion.findFirst({ where: { examId }, orderBy: { position: "desc" } });
    return { exam, question: current };
  }
  if (exam.status !== "CREATED") throw new ExamNotActiveError();

  const started = await prisma.exam.update({ where: { id: exam.id }, data: { status: "ACTIVE", startedAt: new Date() } });

  if (exam.mode === "ORAL") {
    const blueprint = exam.blueprint as unknown as ReturnType<typeof buildExamBlueprint>;
    const firstConcept = blueprint.entries[0];
    if (!firstConcept) return { exam: started, question: null };

    const concept = await prisma.concept.findUnique({ where: { id: firstConcept.conceptId }, select: { name: true, description: true } });
    const message = await generateOralExaminerMessage(
      { conceptName: concept?.name ?? firstConcept.conceptName, conceptDescription: concept?.description ?? "", depth: 1, conversationHistory: [] },
      userId,
    );

    const question = await prisma.examQuestion.create({
      data: {
        examId: started.id,
        conceptId: firstConcept.conceptId,
        questionType: "OPEN_ENDED",
        cognitiveLevel: "RECALL",
        difficulty: started.difficulty,
        position: 1,
        prompt: message,
      },
    });
    return { exam: started, question };
  }

  const question = await prisma.examQuestion.findFirst({ where: { examId }, orderBy: { position: "asc" } });
  return { exam: started, question };
}

export interface ExamStateSnapshot {
  exam: Exam;
  remainingSeconds: number | null;
  questions: Array<ReturnType<typeof toStudentFacingQuestion> & { answered: boolean }>;
}

/** Reconstructs an in-progress exam's state — safe to call after any page refresh (spec §17). Server-computed remaining time only; the client's own timer is display-only (spec §16, §55). */
export async function getExamState(examId: string, userId: string): Promise<ExamStateSnapshot | null> {
  const exam = await loadOwnedExam(examId, userId);
  if (!exam) return null;

  if (isExamTimeExpired(exam) && exam.status === "ACTIVE") {
    await prisma.exam.update({ where: { id: exam.id }, data: { status: "EXPIRED" } });
    exam.status = "EXPIRED";
  }

  const questions = await prisma.examQuestion.findMany({
    where: { examId },
    orderBy: { position: "asc" },
    include: { answer: { select: { id: true } } },
  });

  return {
    exam,
    remainingSeconds: computeRemainingSeconds(exam),
    questions: questions.map((q) => ({ ...toStudentFacingQuestion(q), answered: !!q.answer })),
  };
}

// ---------------------------------------------------------------------------
// Answering (spec §14-20)
// ---------------------------------------------------------------------------

export interface SubmitAnswerInput {
  examId: string;
  userId: string;
  questionId: string;
  answerText?: string | null;
  selectedOptionIds?: string[] | null;
  confidence?: ExamConfidenceLevelValue | null;
  timeSpentSeconds?: number;
  hintsUsed?: number;
  revealedAnswer?: boolean;
}

export interface SubmitAnswerResult {
  saved: true;
  nextQuestion: ReturnType<typeof toStudentFacingQuestion> | null;
  examComplete: boolean;
}

async function autoGradeOrRubric(question: ExamQuestion, answerText: string, selectedOptionIds: string[], userId: string) {
  if (AUTO_GRADED_TYPES.includes(question.questionType)) {
    const correctOptionIds = Array.isArray(question.correctOptionIds) ? (question.correctOptionIds as string[]) : [];
    const graded =
      question.questionType === "MULTI_SELECT"
        ? gradeMultiSelect(selectedOptionIds, correctOptionIds)
        : gradeSingleSelect(selectedOptionIds, correctOptionIds);
    return { ...graded, criteriaScores: null as Prisma.InputJsonValue | null, feedback: null as string | null, missingConcepts: [] as string[], severity: null as MistakeSeverity | null };
  }

  const concept = await prisma.concept.findUnique({ where: { id: question.conceptId }, select: { name: true } });
  const sourceChunks =
    Array.isArray(question.sourceReferences) && question.sourceReferences.length > 0
      ? await prisma.documentChunk.findMany({ where: { id: { in: question.sourceReferences as string[] } }, select: { id: true, text: true } })
      : [];

  const grading = await gradeExamAnswer(
    {
      conceptName: concept?.name ?? "this concept",
      questionPrompt: question.prompt,
      questionType: question.questionType,
      scenario: question.scenario as { context: string; objective: string; constraints: string[]; availableInformation: string[] } | null,
      expectedAnswer: question.expectedAnswer,
      rubric: Array.isArray(question.rubric) ? (question.rubric as string[]) : [],
      sourceChunks,
      studentAnswer: answerText,
    },
    userId,
  );
  const graded = gradeFromRubric(answerText, grading);

  return {
    ...graded,
    criteriaScores: grading.criteria as unknown as Prisma.InputJsonValue,
    feedback: grading.feedback,
    missingConcepts: grading.missingConcepts,
    severity: (grading.severity as MistakeSeverity | null) ?? null,
  };
}

/** Persists (creates or updates) and eagerly grades one answer — grading happens now, but is never revealed to the student until the exam is submitted (spec §14, §63). */
export async function submitExamAnswer(input: SubmitAnswerInput): Promise<SubmitAnswerResult> {
  const exam = await loadOwnedExam(input.examId, input.userId);
  if (!exam) throw new ExamNotFoundError();

  if (isExamTimeExpired(exam)) {
    await prisma.exam.update({ where: { id: exam.id }, data: { status: "EXPIRED" } });
    throw new ExamNotActiveError();
  }
  if (exam.status !== "ACTIVE") throw new ExamNotActiveError();

  const question = await prisma.examQuestion.findFirst({ where: { id: input.questionId, examId: exam.id } });
  if (!question) throw new QuestionNotFoundError();

  const answerText = input.answerText?.trim() ?? "";
  const selectedOptionIds = input.selectedOptionIds ?? [];
  // Hints/reveal are never trusted from the client when the exam itself
  // disallows them (spec §14-15, §55) — a client claiming hintsUsed/
  // revealedAnswer on a no-hints exam must not be able to zero out its own
  // mastery evidence weight.
  const hintsUsed = exam.allowHints ? (input.hintsUsed ?? 0) : 0;
  const revealedAnswer = exam.allowHints ? (input.revealedAnswer ?? false) : false;
  const graded = await autoGradeOrRubric(question, answerText, selectedOptionIds, input.userId);

  const answer = await prisma.examAnswer.upsert({
    where: { questionId: question.id },
    create: {
      examId: exam.id,
      questionId: question.id,
      userId: input.userId,
      answerText: answerText || null,
      selectedOptionIds: selectedOptionIds.length > 0 ? (selectedOptionIds as unknown as Prisma.InputJsonValue) : undefined,
      confidence: input.confidence ?? undefined,
      timeSpentSeconds: input.timeSpentSeconds ?? 0,
      hintsUsed,
      revealedAnswer,
      classification: graded.classification,
      score: graded.score,
      criteriaScores: graded.criteriaScores ?? undefined,
      feedback: graded.feedback,
      missingConcepts: graded.missingConcepts as unknown as Prisma.InputJsonValue,
      mistakeSeverity: graded.severity ?? undefined,
      submittedAt: new Date(),
    },
    update: {
      answerText: answerText || null,
      selectedOptionIds: selectedOptionIds.length > 0 ? (selectedOptionIds as unknown as Prisma.InputJsonValue) : undefined,
      confidence: input.confidence ?? undefined,
      timeSpentSeconds: input.timeSpentSeconds ?? 0,
      hintsUsed,
      revealedAnswer,
      classification: graded.classification,
      score: graded.score,
      criteriaScores: graded.criteriaScores ?? undefined,
      feedback: graded.feedback,
      missingConcepts: graded.missingConcepts as unknown as Prisma.InputJsonValue,
      mistakeSeverity: graded.severity ?? undefined,
      submittedAt: new Date(),
    },
  });

  await prisma.exam.update({ where: { id: exam.id }, data: { currentQuestionIndex: Math.max(exam.currentQuestionIndex, question.position) } });

  if (exam.mode === "ADAPTIVE") {
    return submitAdaptiveAnswer(exam, question, answer, input.userId);
  }
  if (exam.mode === "ORAL") {
    return submitOralAnswer(exam, question, answer, input.userId);
  }

  return { saved: true, nextQuestion: null, examComplete: false };
}

async function submitAdaptiveAnswer(exam: Exam, question: ExamQuestion, answer: ExamAnswer, userId: string): Promise<SubmitAnswerResult> {
  const blueprint = exam.blueprint as unknown as ReturnType<typeof buildExamBlueprint>;
  const plan = planAdaptiveSequence(blueprint);
  const consumedCount = await prisma.examQuestion.count({ where: { examId: exam.id } });
  const state = await getStudentLearningState(userId, exam.courseId);
  if (!state) return { saved: true, nextQuestion: null, examComplete: true };

  const concept = await prisma.concept.findUnique({ where: { id: question.conceptId }, select: { name: true } });
  const lastAnswer: LastAdaptiveAnswer = {
    conceptId: question.conceptId,
    conceptName: concept?.name ?? "this concept",
    classification: answer.classification ?? "UNANSWERED",
    score: answer.score ?? 0,
  };

  const step = nextAdaptiveStep({ state, plannedSteps: plan, consumedCount, lastAnswer, currentDifficulty: question.difficulty });
  if (!step || consumedCount >= exam.questionCount) {
    return { saved: true, nextQuestion: null, examComplete: true };
  }

  const questionType = step.reason === "PLANNED" ? questionTypeForStep(step.cognitiveLevel) : "SHORT_ANSWER";
  const next = await getOrGenerateExamQuestion({
    examId: exam.id,
    courseId: exam.courseId,
    conceptId: step.conceptId,
    questionType,
    cognitiveLevel: step.cognitiveLevel,
    difficulty: step.difficulty,
    position: consumedCount + 1,
    userId,
  });

  return { saved: true, nextQuestion: next ? toStudentFacingQuestion(next) : null, examComplete: !next };
}

function questionTypeForStep(level: "RECALL" | "UNDERSTAND" | "APPLY" | "ANALYZE" | "EVALUATE") {
  if (level === "RECALL") return "MULTIPLE_CHOICE" as const;
  if (level === "UNDERSTAND") return "SHORT_ANSWER" as const;
  return "OPEN_ENDED" as const;
}

async function submitOralAnswer(exam: Exam, question: ExamQuestion, answer: ExamAnswer, userId: string): Promise<SubmitAnswerResult> {
  const blueprint = exam.blueprint as unknown as ReturnType<typeof buildExamBlueprint>;
  // Every question for this concept BEFORE the one just answered — used to
  // compute the depth/streak *going into* this answer, per
  // nextOralProgression's contract (it computes the *new* depth/streak
  // from these plus the just-submitted classification itself).
  const priorForConcept = await prisma.examQuestion.findMany({
    where: { examId: exam.id, conceptId: question.conceptId, id: { not: question.id } },
    orderBy: { position: "asc" },
    include: { answer: true },
  });

  const depthBeforeThisAnswer = priorForConcept.length + 1; // the question just answered was itself depth (priorForConcept.length + 1)
  let consecutiveWeakBefore = 0;
  for (let i = priorForConcept.length - 1; i >= 0; i--) {
    const cls = priorForConcept[i].answer?.classification;
    if (cls === "CORRECT" || cls === "PARTIALLY_CORRECT") break;
    consecutiveWeakBefore += 1;
  }

  const progression = nextOralProgression(depthBeforeThisAnswer, consecutiveWeakBefore, answer.classification ?? "UNANSWERED");
  const conceptIndex = blueprint.entries.findIndex((e) => e.conceptId === question.conceptId);
  const nextConceptEntry = progression.advanceToNextConcept ? blueprint.entries[conceptIndex + 1] : null;

  if (progression.advanceToNextConcept && !nextConceptEntry) {
    return { saved: true, nextQuestion: null, examComplete: true };
  }

  const targetConceptId = progression.advanceToNextConcept ? nextConceptEntry!.conceptId : question.conceptId;
  const depth = progression.advanceToNextConcept ? 1 : progression.nextDepth;

  const concept = await prisma.concept.findUnique({ where: { id: targetConceptId }, select: { name: true, description: true } });
  const history = progression.advanceToNextConcept
    ? []
    : [...priorForConcept, { ...question, answer }].flatMap((q) => [
        { role: "examiner", content: q.prompt },
        ...(q.answer?.answerText ? [{ role: "student", content: q.answer.answerText }] : []),
      ]);

  const message = await generateOralExaminerMessage(
    { conceptName: concept?.name ?? "this concept", conceptDescription: concept?.description ?? "", depth, conversationHistory: history },
    userId,
  );

  const position = (await prisma.examQuestion.count({ where: { examId: exam.id } })) + 1;
  const nextQuestion = await prisma.examQuestion.create({
    data: {
      examId: exam.id,
      conceptId: targetConceptId,
      questionType: "OPEN_ENDED",
      cognitiveLevel: cognitiveLevelForDepth(depth),
      difficulty: exam.difficulty,
      position,
      prompt: message,
    },
  });

  return { saved: true, nextQuestion: toStudentFacingQuestion(nextQuestion), examComplete: false };
}

// ---------------------------------------------------------------------------
// Submission / grading (spec §55-56, §63-64)
// ---------------------------------------------------------------------------

export interface ExamResultSummary extends ExamResultAggregate {
  examId: string;
  readiness: ReadinessOutput;
  nextAction: NextBestExamActionResult;
  weakConcepts: string[];
  questions: Array<{
    questionId: string;
    prompt: string;
    conceptName: string;
    classification: string | null;
    score: number | null;
    feedback: string | null;
    missingConcepts: string[];
    expectedAnswer: string | null;
  }>;
}

async function recordExamEvidence(examId: string, userId: string, mistakesByQuestionId: Map<string, { category: string; severity: string }>) {
  const answers = await prisma.examAnswer.findMany({
    where: { examId },
    include: { question: { select: { conceptId: true, questionType: true, difficulty: true } } },
  });

  for (const answer of answers) {
    if (answer.classification === "UNANSWERED") continue;
    const evidenceScore = evidenceScoreForExamAnswer(answer.score ?? 0, answer.hintsUsed, answer.revealedAnswer);
    if (evidenceScore === null) continue; // revealed answers produce no independent evidence (spec §15).

    const mistake = mistakesByQuestionId.get(answer.questionId);
    const mistakes: MistakeInput[] = mistake
      ? [
          {
            category: toStudentMistakeCategory(mistake.category as (typeof EXAM_MISTAKE_CATEGORIES)[number]),
            description: `Exam mistake (${mistake.category}).`,
            severity: mistake.severity as MistakeSeverity,
          },
        ]
      : [];

    const result = await recordLearningOutcome({
      userId,
      conceptId: answer.question.conceptId,
      activityType: toActivityType(answer.question.questionType),
      score: evidenceScore,
      confidence: confidenceToScore(answer.confidence),
      difficulty: answer.question.difficulty,
      usedHint: answer.hintsUsed > 0,
      revealedAnswer: false,
      durationSeconds: answer.timeSpentSeconds || null,
      mistakes,
      sourceType: "EXAM",
      notes: answer.feedback,
    });

    if (result) {
      await prisma.examAnswer.update({ where: { id: answer.id }, data: { attemptId: result.attempt.id } });
    }
  }
}

/** Idempotent (spec §56): a second call on an already-graded exam just returns the existing result rather than re-grading. */
export async function submitExam(examId: string, userId: string): Promise<ExamResultSummary> {
  const exam = await loadOwnedExam(examId, userId);
  if (!exam) throw new ExamNotFoundError();

  if (exam.status === "GRADED") {
    const existing = await getExamResult(examId, userId);
    if (existing) return existing;
  }
  if (exam.status !== "ACTIVE" && exam.status !== "EXPIRED") throw new ExamNotActiveError();

  const questions = await prisma.examQuestion.findMany({ where: { examId }, include: { answer: true } });
  for (const q of questions) {
    if (!q.answer) {
      await prisma.examAnswer.create({
        data: { examId, questionId: q.id, userId, classification: "UNANSWERED", score: 0, submittedAt: new Date() },
      });
    }
  }

  await prisma.exam.update({ where: { id: exam.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });

  const mistakes = await analyzeExamMistakes(examId, userId, exam.courseId);
  const mistakesByQuestionId = new Map(mistakes.map((m) => [m.questionId, { category: m.category, severity: m.severity }]));

  await recordExamEvidence(examId, userId, mistakesByQuestionId);

  const aggregate = await calculateExamResult(examId, mistakes);
  const readiness = await calculateReadiness(userId, exam.courseId);
  const nextAction = await recommendNextAction({ userId, courseId: exam.courseId, mistakes, readiness });

  await prisma.examResult.create({
    data: {
      examId,
      overallScore: aggregate.overallScore,
      percentage: aggregate.percentage,
      passed: aggregate.passed,
      totalQuestions: aggregate.totalQuestions,
      correctAnswers: aggregate.correctAnswers,
      partialAnswers: aggregate.partialAnswers,
      incorrectAnswers: aggregate.incorrectAnswers,
      unanswered: aggregate.unanswered,
      timeSpentSeconds: aggregate.timeSpentSeconds,
      conceptScores: aggregate.conceptScores as unknown as Prisma.InputJsonValue,
      cognitiveScores: aggregate.cognitiveScores as unknown as Prisma.InputJsonValue,
      mistakeSummary: { ...aggregate.mistakeSummary, nextAction, readiness } as unknown as Prisma.InputJsonValue,
      readinessScore: readiness.readiness,
    },
  });

  await prisma.exam.update({ where: { id: exam.id }, data: { status: "GRADED" } });

  const result = await getExamResult(examId, userId);
  if (!result) throw new ExamNotFoundError();
  return result;
}

export async function getExamResult(examId: string, userId: string): Promise<ExamResultSummary | null> {
  const exam = await prisma.exam.findFirst({ where: { id: examId, userId }, include: { result: true } });
  if (!exam || !exam.result) return null;

  const answers = await prisma.examAnswer.findMany({
    where: { examId },
    include: { question: { select: { prompt: true, expectedAnswer: true, concept: { select: { name: true } } } } },
  });

  const stored = exam.result.mistakeSummary as unknown as ExamResultAggregate["mistakeSummary"] & {
    nextAction: NextBestExamActionResult;
    readiness: ReadinessOutput;
  };
  const { nextAction, readiness, ...mistakeSummary } = stored;

  return {
    examId,
    overallScore: exam.result.overallScore,
    percentage: exam.result.percentage,
    passed: exam.result.passed,
    totalQuestions: exam.result.totalQuestions,
    correctAnswers: exam.result.correctAnswers,
    partialAnswers: exam.result.partialAnswers,
    incorrectAnswers: exam.result.incorrectAnswers,
    unanswered: exam.result.unanswered,
    timeSpentSeconds: exam.result.timeSpentSeconds,
    conceptScores: exam.result.conceptScores as unknown as ExamResultAggregate["conceptScores"],
    cognitiveScores: exam.result.cognitiveScores as unknown as ExamResultAggregate["cognitiveScores"],
    mistakeSummary,
    readiness: readiness ?? { readiness: exam.result.readinessScore ?? 0, status: "DEVELOPING", weakAreas: [], recommendation: "", explanation: "" },
    nextAction,
    weakConcepts: identifyWeakConcepts(exam.result.conceptScores as unknown as ExamResultAggregate["conceptScores"]),
    questions: answers.map((a) => ({
      questionId: a.questionId,
      prompt: a.question.prompt,
      conceptName: a.question.concept.name,
      classification: a.classification,
      score: a.score,
      feedback: a.feedback,
      missingConcepts: Array.isArray(a.missingConcepts) ? (a.missingConcepts as string[]) : [],
      expectedAnswer: a.question.expectedAnswer,
    })),
  };
}

// ---------------------------------------------------------------------------
// History (spec §48-49)
// ---------------------------------------------------------------------------

export interface ExamHistoryEntry {
  id: string;
  mode: Exam["mode"];
  status: Exam["status"];
  isRetest: boolean;
  createdAt: Date;
  submittedAt: Date | null;
  percentage: number | null;
  passed: boolean | null;
}

/** Real, persisted exam history for a course — never fabricated (spec §48). */
export async function listExamHistory(userId: string, courseId: string): Promise<ExamHistoryEntry[]> {
  const exams = await prisma.exam.findMany({
    where: { userId, courseId },
    orderBy: { createdAt: "desc" },
    include: { result: { select: { percentage: true, passed: true } } },
  });

  return exams.map((e) => ({
    id: e.id,
    mode: e.mode,
    status: e.status,
    isRetest: e.isRetest,
    createdAt: e.createdAt,
    submittedAt: e.submittedAt,
    percentage: e.result?.percentage ?? null,
    passed: e.result?.passed ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Retest (spec §46-47)
// ---------------------------------------------------------------------------

export async function createRetest(userId: string, courseId: string, weakConceptIds: string[]): Promise<Exam & { questions: ExamQuestion[] }> {
  return createExam({
    userId,
    courseId,
    mode: "WRITTEN",
    questionCount: Math.min(RETEST_QUESTION_COUNT, weakConceptIds.length * 3),
    durationMinutes: Math.max(10, Math.round((DEFAULT_DURATION_MINUTES * RETEST_QUESTION_COUNT) / DEFAULT_QUESTION_COUNT)),
    difficulty: 2,
    allowHints: false,
    allowSources: false,
    passingScore: DEFAULT_PASSING_SCORE,
    targetConceptIds: weakConceptIds,
    isRetest: true,
  });
}

export function getRemainingSeconds(exam: Pick<Exam, "timeLimitSeconds" | "startedAt">): number | null {
  return computeRemainingSeconds(exam);
}

export function examErrorStatus(error: unknown): { status: number; message: string } {
  if (error instanceof ExamNotFoundError) return { status: 404, message: error.message };
  if (error instanceof ExamNotActiveError) return { status: 409, message: error.message };
  if (error instanceof NoConceptsAvailableError) return { status: 422, message: error.message };
  if (error instanceof QuestionNotFoundError) return { status: 404, message: error.message };
  if (error instanceof ExamGenerationFailedError) return { status: 502, message: error.message };
  if (error instanceof Error) return { status: 400, message: error.message };
  return { status: 500, message: "Something went wrong." };
}
