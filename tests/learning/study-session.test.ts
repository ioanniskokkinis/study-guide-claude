import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", () => ({ extractStructured: vi.fn() }));

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import {
  completeSession,
  getOrStartSession,
  getSessionState,
  nextQuestion,
  QuestionAlreadyAnsweredError,
  requestHint,
  revealAnswer,
  SessionNotActiveError,
  submitAnswer,
} from "@/lib/learning/study-session";

const QUESTION_PROMPTS = [
  "What does a stateful firewall track between packets?",
  "Explain why connection state matters for a stateful firewall.",
  "How would a stateful firewall handle an unexpected packet?",
  "Describe the role of state tracking in firewall filtering.",
  "What information does a stateful firewall retain about a session?",
  "Why does tracking connection state improve filtering accuracy?",
];

describe("study-session (Active Recall)", () => {
  let userId: string;
  let otherUserId: string;
  let courseId: string;
  let conceptId: string;
  let chunkId: string;
  let promptIndex = 0;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-session-${suffix}@example.com` } });
    userId = user.id;
    const other = await prisma.user.create({ data: { email: `test-session-other-${suffix}@example.com` } });
    otherUserId = other.id;

    const course = await prisma.course.create({ data: { userId, title: "Networking", knowledgeStatus: "READY" } });
    courseId = course.id;

    const concept = await prisma.concept.create({
      data: {
        courseId,
        name: "Firewalls",
        normalizedName: "firewalls",
        description: "Devices that filter network traffic using rules.",
        difficulty: 2,
      },
    });
    conceptId = concept.id;

    const document = await prisma.document.create({
      data: {
        courseId,
        filename: "f.pdf",
        originalFilename: "lecture.pdf",
        mimeType: "application/pdf",
        fileSize: 10,
        type: "pdf",
        storagePath: "x/y.pdf",
        processingStatus: "READY",
      },
    });
    const chunk = await prisma.documentChunk.create({
      data: {
        documentId: document.id,
        text: "Stateful firewalls track connection state to decide whether to allow or deny a packet.",
        chunkIndex: 0,
        tokenCount: 20,
      },
    });
    chunkId = chunk.id;

    await prisma.conceptSource.create({
      data: { conceptId, documentChunkId: chunk.id, evidence: "Stateful firewalls track connection state." },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  beforeEach(() => {
    vi.mocked(extractStructured).mockReset();
    vi.mocked(extractStructured).mockImplementation(async (options: { requestType: string }) => {
      if (options.requestType === "QUESTION_GENERATION" || options.requestType === "REMEDIATION") {
        return {
          data: {
            canGenerate: true,
            prompt: QUESTION_PROMPTS[promptIndex++ % QUESTION_PROMPTS.length],
            expectedAnswer: "Connection state.",
            rubric: ["Mentions connection state"],
            sourceChunkIds: [chunkId],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      if (options.requestType === "ANSWER_EVALUATION") {
        return { data: currentEvaluation(), usage: { inputTokens: 1, outputTokens: 1 } };
      }
      if (options.requestType === "HINT_GENERATION") {
        return { data: { hint: "Think about what state is tracked." }, usage: { inputTokens: 1, outputTokens: 1 } };
      }
      throw new Error(`unmocked requestType ${options.requestType}`);
    });
  });

  let evaluationOverride: Record<string, unknown> | null = null;
  function currentEvaluation() {
    return {
      score: 0.9,
      correctness: "CORRECT",
      reasoningQuality: 0.85,
      completeness: 0.85,
      strengths: ["Correctly identified state tracking"],
      missingPoints: [],
      errors: [],
      misconceptions: [],
      feedback: "Nicely done.",
      correctAnswer: "A stateful firewall tracks connection state.",
      needsRemediation: false,
      ...evaluationOverride,
    };
  }

  it("creates a session with an assigned first question (session creation + question assignment)", async () => {
    const state = await getOrStartSession(userId, courseId);
    expect(state).not.toBeNull();
    expect(state!.session.status).toBe("ACTIVE");
    expect(state!.currentSessionQuestion).not.toBeNull();
    expect(state!.currentSessionQuestion!.question.conceptId).toBe(conceptId);
    expect(state!.currentSessionQuestion!.position).toBe(1);

    await completeSession(state!.session.id, userId);
  });

  it("resumes an existing ACTIVE session instead of creating a second one", async () => {
    const first = await getOrStartSession(userId, courseId);
    const second = await getOrStartSession(userId, courseId);
    expect(second!.session.id).toBe(first!.session.id);

    await completeSession(first!.session.id, userId);
  });

  it("full outcome chain: submitting an answer creates an attempt, evidence, mastery update, and mistake", async () => {
    evaluationOverride = {
      correctness: "PARTIAL",
      score: 0.5,
      errors: [{ category: "INCOMPLETE_ANSWER", description: "Missed the timeout aspect.", severity: "LOW" }],
    };

    const state = await getOrStartSession(userId, courseId);
    const sq = state!.currentSessionQuestion!;

    const attemptsBefore = await prisma.learningAttempt.count({ where: { userId, conceptId } });
    const evidenceBefore = await prisma.knowledgeEvidence.count({ where: { userId, conceptId } });
    const mistakesBefore = await prisma.studentMistake.count({ where: { userId, conceptId } });

    const result = await submitAnswer({
      sessionId: state!.session.id,
      userId,
      sessionQuestionId: sq.id,
      answerText: "It tracks connection state but I forgot about timeouts.",
      confidence: 4,
    });

    expect(result.evaluation.correctness).toBe("PARTIAL");
    expect(result.answer.attemptId).toBeTruthy();

    const [attemptsAfter, evidenceAfter, mistakesAfter, mastery] = await Promise.all([
      prisma.learningAttempt.count({ where: { userId, conceptId } }),
      prisma.knowledgeEvidence.count({ where: { userId, conceptId } }),
      prisma.studentMistake.count({ where: { userId, conceptId } }),
      prisma.studentConceptMastery.findUnique({ where: { userId_conceptId: { userId, conceptId } } }),
    ]);

    expect(attemptsAfter).toBe(attemptsBefore + 1);
    expect(evidenceAfter).toBe(evidenceBefore + 1);
    expect(mistakesAfter).toBe(mistakesBefore + 1);
    expect(mastery).not.toBeNull();
    expect(mastery!.exposureCount).toBeGreaterThan(0);

    evaluationOverride = null;
    await completeSession(state!.session.id, userId);
  });

  it("rejects a second submission for the same question (no duplicate outcomes)", async () => {
    const state = await getOrStartSession(userId, courseId);
    const sq = state!.currentSessionQuestion!;

    await submitAnswer({ sessionId: state!.session.id, userId, sessionQuestionId: sq.id, answerText: "Connection state." });

    await expect(
      submitAnswer({ sessionId: state!.session.id, userId, sessionQuestionId: sq.id, answerText: "Trying again." }),
    ).rejects.toBeInstanceOf(QuestionAlreadyAnsweredError);

    await completeSession(state!.session.id, userId);
  });

  it("records a hint without it counting as an unaided success", async () => {
    const state = await getOrStartSession(userId, courseId);
    const sq = state!.currentSessionQuestion!;

    const hintResult = await requestHint({ sessionId: state!.session.id, userId, sessionQuestionId: sq.id });
    expect(hintResult.hint.length).toBeGreaterThan(0);
    expect(hintResult.hintsUsed).toBe(1);

    const result = await submitAnswer({
      sessionId: state!.session.id,
      userId,
      sessionQuestionId: sq.id,
      answerText: "Connection state, thanks to the hint.",
    });

    expect(result.answer.usedHint).toBe(true);
    const attempt = await prisma.learningAttempt.findUnique({ where: { id: result.answer.attemptId! } });
    expect(attempt!.usedHint).toBe(true);

    await completeSession(state!.session.id, userId);
  });

  it("records a reveal as a zero-credit, non-successful outcome distinct from a normal retrieval", async () => {
    const state = await getOrStartSession(userId, courseId);
    const sq = state!.currentSessionQuestion!;

    const before = await prisma.studentConceptMastery.findUnique({ where: { userId_conceptId: { userId, conceptId } } });

    const revealed = await revealAnswer({ sessionId: state!.session.id, userId, sessionQuestionId: sq.id });
    expect(revealed.correctAnswer.length).toBeGreaterThan(0);

    const sessionQuestion = await prisma.studySessionQuestion.findUniqueOrThrow({ where: { id: sq.id } });
    expect(sessionQuestion.revealed).toBe(true);
    expect(sessionQuestion.answeredAt).not.toBeNull();

    const attempt = await prisma.learningAttempt.findUnique({ where: { id: sessionQuestion.attemptId! } });
    expect(attempt!.revealedAnswer).toBe(true);
    expect(attempt!.score).toBe(0);

    const after = await prisma.studentConceptMastery.findUnique({ where: { userId_conceptId: { userId, conceptId } } });
    expect(after!.successCount).toBe(before?.successCount ?? 0);
    expect(after!.failureCount).toBeGreaterThan(before?.failureCount ?? 0);

    // Revealing already settles the question — attempting to submit an answer afterward must be rejected.
    await expect(
      submitAnswer({ sessionId: state!.session.id, userId, sessionQuestionId: sq.id, answerText: "too late" }),
    ).rejects.toBeInstanceOf(QuestionAlreadyAnsweredError);

    await completeSession(state!.session.id, userId);
  });

  it("advances to a fresh next question and completes the session with a summary", async () => {
    const state = await getOrStartSession(userId, courseId);
    const sq = state!.currentSessionQuestion!;

    await submitAnswer({ sessionId: state!.session.id, userId, sessionQuestionId: sq.id, answerText: "Connection state." });

    const next = await nextQuestion({ sessionId: state!.session.id, userId });
    expect(next.sessionQuestion.id).not.toBe(sq.id);
    expect(next.sessionQuestion.question.prompt).not.toBe(sq.question.prompt);

    await submitAnswer({
      sessionId: state!.session.id,
      userId,
      sessionQuestionId: next.sessionQuestion.id,
      answerText: "Connection state again.",
    });

    const summary = await completeSession(state!.session.id, userId);
    expect(summary).not.toBeNull();
    expect(summary!.questionsAnswered).toBe(2);
    expect(summary!.conceptsPracticed).toContain("Firewalls");

    const finalSession = await prisma.studySession.findUniqueOrThrow({ where: { id: state!.session.id } });
    expect(finalSession.status).toBe("COMPLETED");
    expect(finalSession.completedAt).not.toBeNull();
  });

  describe("security — cross-user access", () => {
    it("another user cannot read this user's session state", async () => {
      const state = await getOrStartSession(userId, courseId);
      const foreign = await getSessionState(state!.session.id, otherUserId);
      expect(foreign).toBeNull();
      await completeSession(state!.session.id, userId);
    });

    it("another user cannot submit an answer to this user's session/question", async () => {
      const state = await getOrStartSession(userId, courseId);
      const sq = state!.currentSessionQuestion!;

      await expect(
        submitAnswer({ sessionId: state!.session.id, userId: otherUserId, sessionQuestionId: sq.id, answerText: "hijack" }),
      ).rejects.toBeInstanceOf(SessionNotActiveError);

      await completeSession(state!.session.id, userId);
    });

    it("another user cannot request a hint or reveal on this user's question", async () => {
      const state = await getOrStartSession(userId, courseId);
      const sq = state!.currentSessionQuestion!;

      await expect(
        requestHint({ sessionId: state!.session.id, userId: otherUserId, sessionQuestionId: sq.id }),
      ).rejects.toBeInstanceOf(SessionNotActiveError);
      await expect(
        revealAnswer({ sessionId: state!.session.id, userId: otherUserId, sessionQuestionId: sq.id }),
      ).rejects.toBeInstanceOf(SessionNotActiveError);

      await completeSession(state!.session.id, userId);
    });
  });
});
