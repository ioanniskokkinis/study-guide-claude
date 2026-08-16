import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", () => ({ extractStructured: vi.fn() }));

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import {
  createExam,
  createRetest,
  getExamResult,
  startExam,
  submitExam,
  submitExamAnswer,
} from "@/lib/exam/exam-orchestrator";

interface MockCallOptions {
  requestType: string;
}

let questionCounter = 0;
let nextGradingResult: Record<string, unknown> = {};
/** Shared across every describe block in this file — question generation grounds itself against whatever chunk ids exist here, keyed by conceptId. Each course's seed step adds its own concepts' chunk ids. */
const chunkIdsByConcept: Record<string, string> = {};

function defaultGradingResult(): Record<string, unknown> {
  return {
    classification: "CORRECT",
    criteria: { correctness: 0.9, completeness: 0.9, reasoning: 0.9, application: 0.9, conceptualUnderstanding: 0.9 },
    missingConcepts: [],
    misconceptions: [],
    severity: null,
    feedback: "Solid answer.",
  };
}

const AUTO_GRADED = new Set(["MULTIPLE_CHOICE", "MULTI_SELECT", "TRUE_FALSE"]);

/** Builds a type-appropriate EXAM_QUESTION_GENERATION response by reading the actual requested format and cited chunk ids straight out of the prompt text — never a fixed shape, so it stays correct regardless of which type/concept was requested. */
function mockQuestionGeneration(prompt: string) {
  questionCounter += 1;
  const formatMatch = prompt.match(/Question format: (\w+)/);
  const questionType = formatMatch?.[1] ?? "SHORT_ANSWER";
  const chunkIds = [...prompt.matchAll(/Chunk (\S+):/g)].map((m) => m[1]);

  if (AUTO_GRADED.has(questionType)) {
    return {
      canGenerate: true,
      prompt: `Generated question #${questionCounter}?`,
      options: [
        { id: "a", text: "Option A" },
        { id: "b", text: "Option B" },
      ],
      correctOptionIds: ["a"],
      sourceChunkIds: chunkIds,
    };
  }
  if (questionType === "SCENARIO") {
    return {
      canGenerate: true,
      prompt: `Generated scenario question #${questionCounter}?`,
      scenario: { context: "A server is under load.", objective: "Decide what to check first.", constraints: [], availableInformation: [] },
      rubric: ["Mentions the key mechanism", "Explains why it matters"],
      sourceChunkIds: chunkIds,
    };
  }
  return {
    canGenerate: true,
    prompt: `Generated question #${questionCounter}?`,
    expectedAnswer: "The correct reference answer.",
    rubric: ["Mentions the key mechanism", "Explains why it matters"],
    sourceChunkIds: chunkIds,
  };
}

function installDefaultMock() {
  vi.mocked(extractStructured).mockImplementation(async (options: unknown) => {
    const { requestType } = options as MockCallOptions;
    const prompt = (options as { prompt?: string }).prompt ?? "";
    const usage = { inputTokens: 1, outputTokens: 1 };

    if (requestType === "EXAM_QUESTION_GENERATION") return { data: mockQuestionGeneration(prompt), usage };
    if (requestType === "EXAM_ANSWER_GRADING") return { data: nextGradingResult, usage };
    if (requestType === "EXAM_ORAL_EXAMINER") return { data: { message: "Tell me more about that." }, usage };
    throw new Error(`unmocked requestType ${requestType}`);
  });
}

async function seedConceptWithSource(courseId: string, documentId: string, name: string, chunkIndex: number) {
  const concept = await prisma.concept.create({
    data: { courseId, name, normalizedName: name.toLowerCase(), description: `${name} description.` },
  });
  const chunk = await prisma.documentChunk.create({
    data: { documentId, text: `Source material about ${name}.`, chunkIndex, tokenCount: 20 },
  });
  await prisma.conceptSource.create({ data: { conceptId: concept.id, documentChunkId: chunk.id, evidence: `About ${name}.` } });
  chunkIdsByConcept[concept.id] = chunk.id;
  return concept;
}

describe("exam orchestrator (integration)", () => {
  let userId: string;
  let courseId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-exam-${suffix}@example.com` } });
    userId = user.id;
    const course = await prisma.course.create({ data: { userId, title: `Exam ${suffix}`, knowledgeStatus: "READY" } });
    courseId = course.id;

    const document = await prisma.document.create({
      data: {
        courseId,
        filename: "f.pdf",
        originalFilename: "networking.pdf",
        mimeType: "application/pdf",
        fileSize: 10,
        type: "pdf",
        storagePath: "x/y.pdf",
        processingStatus: "READY",
      },
    });

    const names = ["TCP", "Ports", "Firewalls"];
    for (let i = 0; i < names.length; i++) {
      await seedConceptWithSource(courseId, document.id, names[i], i);
    }
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  beforeEach(() => {
    vi.mocked(extractStructured).mockReset();
    questionCounter = 0;
    nextGradingResult = defaultGradingResult();
    installDefaultMock();
  });

  it("creates a WRITTEN exam with real, grounded questions", async () => {
    const exam = await createExam({
      courseId,
      userId,
      mode: "WRITTEN",
      questionCount: 6,
      durationMinutes: 20,
      difficulty: 2,
      allowHints: false,
      allowSources: false,
      passingScore: 0.75,
    });

    expect(exam.status).toBe("CREATED");
    expect(exam.questions.length).toBeGreaterThan(0);
    expect(exam.questions.every((q) => q.examId === exam.id)).toBe(true);
  });

  it("start transitions CREATED -> ACTIVE and sets a server timestamp", async () => {
    const exam = await createExam({
      courseId,
      userId,
      mode: "WRITTEN",
      questionCount: 4,
      durationMinutes: 20,
      difficulty: 2,
      allowHints: false,
      allowSources: false,
      passingScore: 0.75,
    });
    const { exam: started } = await startExam(exam.id, userId);
    expect(started.status).toBe("ACTIVE");
    expect(started.startedAt).not.toBeNull();
  });

  it("multiple-choice answers are graded deterministically without any Claude call", async () => {
    const exam = await createExam({
      courseId,
      userId,
      mode: "WRITTEN",
      questionCount: 4,
      durationMinutes: 20,
      difficulty: 2,
      allowHints: false,
      allowSources: false,
      passingScore: 0.75,
    });
    await startExam(exam.id, userId);
    const concept = await prisma.concept.findFirst({ where: { courseId } });

    // Constructed directly rather than relying on generation to happen to
    // produce a MULTIPLE_CHOICE question for this exam (its cognitive-level
    // mix is legitimately variable question to question) — this test is
    // about the deterministic grading path, not the generator's mix.
    const mcQuestion = await prisma.examQuestion.create({
      data: {
        examId: exam.id,
        conceptId: concept!.id,
        questionType: "MULTIPLE_CHOICE",
        cognitiveLevel: "RECALL",
        difficulty: 2,
        position: 999,
        prompt: "Which option is correct?",
        options: [
          { id: "a", text: "Correct" },
          { id: "b", text: "Wrong" },
        ],
        correctOptionIds: ["a"],
      },
    });

    vi.mocked(extractStructured).mockClear();
    await submitExamAnswer({ examId: exam.id, userId, questionId: mcQuestion.id, selectedOptionIds: ["a"] });
    expect(extractStructured).not.toHaveBeenCalled();

    const answer = await prisma.examAnswer.findUnique({ where: { questionId: mcQuestion.id } });
    expect(answer?.classification).toBe("CORRECT");
    expect(answer?.score).toBe(1);
  });

  it("submitting an answer never reveals the grade back to the client (spec §14, §63)", async () => {
    const exam = await createExam({
      courseId,
      userId,
      mode: "WRITTEN",
      questionCount: 4,
      durationMinutes: 20,
      difficulty: 2,
      allowHints: false,
      allowSources: false,
      passingScore: 0.75,
    });
    await startExam(exam.id, userId);
    const question = await prisma.examQuestion.findFirst({ where: { examId: exam.id } });

    const result = await submitExamAnswer({ examId: exam.id, userId, questionId: question!.id, selectedOptionIds: ["b"] });
    expect(result).not.toHaveProperty("classification");
    expect(result).not.toHaveProperty("score");
  });

  it("submit is idempotent — a second call returns the same result without creating a duplicate", async () => {
    const exam = await createExam({
      courseId,
      userId,
      mode: "WRITTEN",
      questionCount: 3,
      durationMinutes: 20,
      difficulty: 2,
      allowHints: false,
      allowSources: false,
      passingScore: 0.75,
    });
    await startExam(exam.id, userId);

    const first = await submitExam(exam.id, userId);
    const second = await submitExam(exam.id, userId);
    expect(second.examId).toBe(first.examId);
    expect(second.percentage).toBe(first.percentage);

    const resultCount = await prisma.examResult.count({ where: { examId: exam.id } });
    expect(resultCount).toBe(1);
  });

  it("submitting updates the Student Knowledge Model (spec §23, §64)", async () => {
    const exam = await createExam({
      courseId,
      userId,
      mode: "WRITTEN",
      questionCount: 3,
      durationMinutes: 20,
      difficulty: 2,
      allowHints: false,
      allowSources: false,
      passingScore: 0.75,
    });
    await startExam(exam.id, userId);
    const questions = await prisma.examQuestion.findMany({ where: { examId: exam.id } });
    for (const q of questions) {
      await submitExamAnswer({ examId: exam.id, userId, questionId: q.id, selectedOptionIds: q.options ? ["a"] : undefined, answerText: q.options ? undefined : "An answer." });
    }
    await submitExam(exam.id, userId);

    const attempts = await prisma.learningAttempt.count({ where: { userId, conceptId: { in: questions.map((q) => q.conceptId) } } });
    expect(attempts).toBeGreaterThan(0);
  });

  it("unanswered questions are graded as UNANSWERED and counted in the result", async () => {
    const exam = await createExam({
      courseId,
      userId,
      mode: "WRITTEN",
      questionCount: 3,
      durationMinutes: 20,
      difficulty: 2,
      allowHints: false,
      allowSources: false,
      passingScore: 0.75,
    });
    await startExam(exam.id, userId);
    // Answer nothing — submit immediately.
    const result = await submitExam(exam.id, userId);
    expect(result.unanswered).toBe(result.totalQuestions);
  });

  it("hints/reveal claims are ignored when the exam does not allow them (spec §14-15, §55)", async () => {
    const exam = await createExam({
      courseId,
      userId,
      mode: "WRITTEN",
      questionCount: 3,
      durationMinutes: 20,
      difficulty: 2,
      allowHints: false,
      allowSources: false,
      passingScore: 0.75,
    });
    await startExam(exam.id, userId);
    const question = await prisma.examQuestion.findFirst({ where: { examId: exam.id } });

    await submitExamAnswer({
      examId: exam.id,
      userId,
      questionId: question!.id,
      selectedOptionIds: question!.options ? ["a"] : undefined,
      answerText: question!.options ? undefined : "answer",
      hintsUsed: 3,
      revealedAnswer: true,
    });

    const answer = await prisma.examAnswer.findUnique({ where: { questionId: question!.id } });
    expect(answer?.hintsUsed).toBe(0);
    expect(answer?.revealedAnswer).toBe(false);
  });

  it("creates a fresh targeted retest scoped to the given weak concepts", async () => {
    const ports = await prisma.concept.findFirst({ where: { courseId, name: "Ports" } });
    const retest = await createRetest(userId, courseId, [ports!.id]);
    expect(retest.isRetest).toBe(true);
    expect(retest.questions.every((q) => q.conceptId === ports!.id)).toBe(true);
  });

  it("getExamResult returns null before the exam is graded", async () => {
    const exam = await createExam({
      courseId,
      userId,
      mode: "WRITTEN",
      questionCount: 3,
      durationMinutes: 20,
      difficulty: 2,
      allowHints: false,
      allowSources: false,
      passingScore: 0.75,
    });
    const result = await getExamResult(exam.id, userId);
    expect(result).toBeNull();
  });

  describe("end-to-end scenario (spec §70): TCP/IP -> TCP -> Ports -> Firewalls -> Network Attacks", () => {
    let scenarioCourseId: string;
    let tcp: { id: string };
    let ports: { id: string };
    let firewalls: { id: string };

    beforeAll(async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const course = await prisma.course.create({ data: { userId, title: `E2E ${suffix}`, knowledgeStatus: "READY" } });
      scenarioCourseId = course.id;

      const document = await prisma.document.create({
        data: {
          courseId: scenarioCourseId,
          filename: "f.pdf",
          originalFilename: "net.pdf",
          mimeType: "application/pdf",
          fileSize: 10,
          type: "pdf",
          storagePath: "x/y.pdf",
          processingStatus: "READY",
        },
      });

      tcp = await seedConceptWithSource(scenarioCourseId, document.id, "TCP", 0);
      ports = await seedConceptWithSource(scenarioCourseId, document.id, "Ports", 1);
      firewalls = await seedConceptWithSource(scenarioCourseId, document.id, "Firewalls", 2);

      await prisma.conceptRelationship.createMany({
        data: [
          { sourceConceptId: tcp.id, targetConceptId: ports.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
          { sourceConceptId: ports.id, targetConceptId: firewalls.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
        ],
      });

      await prisma.studentConceptMastery.createMany({
        data: [
          { userId, conceptId: tcp.id, overallMastery: 0.9, exposureCount: 5, successCount: 5, status: "STRONG" },
          { userId, conceptId: ports.id, overallMastery: 0.3, exposureCount: 3, status: "LEARNING" },
          { userId, conceptId: firewalls.id, overallMastery: 0.45, exposureCount: 3, status: "LEARNING" },
        ],
      });
    });

    it("blueprint gives broad coverage (TCP included) but tilts diagnostic weight toward Ports/Firewalls", async () => {
      const exam = await createExam({
        courseId: scenarioCourseId,
        userId,
        mode: "WRITTEN",
        questionCount: 9,
        durationMinutes: 30,
        difficulty: 2,
        allowHints: false,
        allowSources: false,
        passingScore: 0.75,
      });

      const conceptIds = exam.questions.map((q) => q.conceptId);
      expect(conceptIds).toContain(tcp.id);
      expect(conceptIds).toContain(ports.id);
      expect(conceptIds).toContain(firewalls.id);

      const tcpCount = conceptIds.filter((id) => id === tcp.id).length;
      const portsCount = conceptIds.filter((id) => id === ports.id).length;
      expect(portsCount).toBeGreaterThanOrEqual(tcpCount);
    });

    it("failing Firewalls diagnoses the weak Ports prerequisite and the recommendation targets Ports (spec §65)", async () => {
      const exam = await createExam({
        courseId: scenarioCourseId,
        userId,
        mode: "WRITTEN",
        questionCount: 6,
        durationMinutes: 20,
        difficulty: 2,
        allowHints: false,
        allowSources: false,
        passingScore: 0.75,
      });
      await startExam(exam.id, userId);

      // Grading must vary by which concept is being graded within the same
      // submission loop — a single shared `nextGradingResult` can't do
      // that, since several free-text (non-auto-graded) questions may be
      // in flight for different concepts. Inspect the prompt's own
      // "Concept: X" line (built by buildAnswerGradingPrompt) instead.
      vi.mocked(extractStructured).mockImplementation(async (options: unknown) => {
        const { requestType } = options as MockCallOptions;
        const prompt = (options as { prompt?: string }).prompt ?? "";
        const usage = { inputTokens: 1, outputTokens: 1 };

        if (requestType === "EXAM_QUESTION_GENERATION") return { data: mockQuestionGeneration(prompt), usage };
        if (requestType === "EXAM_ANSWER_GRADING") {
          // Only TCP is answered correctly in this scenario — Ports must stay weak through the exam too (see the submission loop below).
          const isWeak = prompt.includes("Concept: Firewalls") || prompt.includes("Concept: Ports");
          return {
            data: isWeak
              ? {
                  classification: "INCORRECT",
                  criteria: { correctness: 0.1, completeness: 0.1, reasoning: 0.1, application: 0.1, conceptualUnderstanding: 0.1 },
                  missingConcepts: ["stateful inspection"],
                  misconceptions: [],
                  severity: null,
                  feedback: "Not quite.",
                }
              : {
                  classification: "CORRECT",
                  criteria: { correctness: 0.9, completeness: 0.9, reasoning: 0.9, application: 0.9, conceptualUnderstanding: 0.9 },
                  missingConcepts: [],
                  misconceptions: [],
                  severity: null,
                  feedback: "Good.",
                },
            usage,
          };
        }
        throw new Error(`unmocked requestType ${requestType}`);
      });

      // Only TCP answers are correct — Ports must stay weak *through* the
      // exam (matching the given student state) so the recommendation
      // step, which reads freshly-recorded evidence, still finds it weak.
      // Submitting correct Ports answers here would raise Ports' mastery
      // during the exam itself and defeat the scenario's premise.
      const questions = await prisma.examQuestion.findMany({ where: { examId: exam.id } });
      for (const q of questions) {
        const isCorrect = q.conceptId === tcp.id;
        const wrongOption = q.options ? (q.options as Array<{ id: string }>).find((o) => !(q.correctOptionIds as string[])?.includes(o.id)) : null;
        await submitExamAnswer({
          examId: exam.id,
          userId,
          questionId: q.id,
          selectedOptionIds: q.options ? [isCorrect ? (q.correctOptionIds as string[])[0] : wrongOption!.id] : undefined,
          answerText: q.options
            ? undefined
            : isCorrect
              ? "A correct, thorough answer."
              : "A firewall just blocks everything bad.",
        });
      }

      const result = await submitExam(exam.id, userId);

      expect(result.mistakeSummary.prerequisiteFailures).toBeGreaterThan(0);
      expect(result.nextAction.conceptName).toBe("Ports");
    });
  });
});

/**
 * Production-hardening phase §F/§G/§N — quiz cache hit/miss and duplicate-
 * generation prevention. createExam() reuses an existing, not-yet-submitted
 * exam with the identical request shape instead of calling Claude again —
 * the same mechanism serves both "don't regenerate a cached quiz" and
 * "resume an unfinished one."
 */
describe("createExam reuse (cache + resume)", () => {
  let userId: string;
  let courseId: string;
  let conceptId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-exam-cache-${suffix}@example.com` } });
    userId = user.id;
    const course = await prisma.course.create({ data: { userId, title: `Exam cache ${suffix}`, knowledgeStatus: "READY" } });
    courseId = course.id;

    const document = await prisma.document.create({
      data: {
        courseId,
        filename: "f.pdf",
        originalFilename: "networking.pdf",
        mimeType: "application/pdf",
        fileSize: 10,
        type: "pdf",
        storagePath: "x/y.pdf",
        processingStatus: "READY",
      },
    });
    const concept = await seedConceptWithSource(courseId, document.id, "Subnetting", 0);
    conceptId = concept.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  beforeEach(() => {
    vi.mocked(extractStructured).mockReset();
    questionCounter = 0;
    installDefaultMock();
  });

  function config() {
    return {
      courseId,
      userId,
      mode: "WRITTEN" as const,
      questionCount: 3,
      durationMinutes: 10,
      difficulty: 2,
      allowHints: false,
      allowSources: false,
      passingScore: 0.75,
      targetConceptIds: [conceptId],
    };
  }

  it("reuses an existing, not-yet-submitted exam with the same shape instead of calling Claude again (cache hit)", async () => {
    const first = await createExam(config());
    expect(vi.mocked(extractStructured)).toHaveBeenCalled();
    vi.mocked(extractStructured).mockClear();

    const second = await createExam(config());
    expect(second.id).toBe(first.id);
    expect(extractStructured).not.toHaveBeenCalled();
  });

  it("starts a fresh exam once the reusable one is submitted/graded (no stale reuse after completion)", async () => {
    const first = await createExam(config());
    await startExam(first.id, userId);
    const questions = await prisma.examQuestion.findMany({ where: { examId: first.id } });
    for (const q of questions) {
      await submitExamAnswer({
        examId: first.id,
        userId,
        questionId: q.id,
        selectedOptionIds: q.options ? [(q.correctOptionIds as string[])[0]] : undefined,
        answerText: q.options ? undefined : "A thorough answer.",
      });
    }
    await submitExam(first.id, userId);

    vi.mocked(extractStructured).mockClear();
    const second = await createExam(config());
    expect(second.id).not.toBe(first.id);
    expect(extractStructured).toHaveBeenCalled();
  });

  it("does not reuse an exam scoped to a different concept", async () => {
    const first = await createExam(config());

    const document = await prisma.document.findFirstOrThrow({ where: { courseId } });
    const otherConcept = await seedConceptWithSource(courseId, document.id, "Routing", 1);

    vi.mocked(extractStructured).mockClear();
    const second = await createExam({ ...config(), targetConceptIds: [otherConcept.id] });
    expect(second.id).not.toBe(first.id);
    expect(extractStructured).toHaveBeenCalled();
  });
});
