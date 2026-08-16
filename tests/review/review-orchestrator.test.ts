import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/claude")>("@/lib/ai/claude");
  return { ...actual, extractStructured: vi.fn() };
});

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import { evaluateSubmittedAnswer, submitAnswer } from "@/lib/learning/study-session";
import {
  completeReviewSession,
  getActiveReviewSessionId,
  getOrStartReviewSession,
  NoReviewsDueError,
  nextReviewQuestion,
  ReviewNotRatedError,
  submitReviewRating,
} from "@/lib/review/review-orchestrator";
import { ensureReviewItemsForCourse, getDueReviews, getReviewState } from "@/lib/review/review-queries";

const QUESTION_PROMPTS = [
  "What does a stateful firewall track between packets?",
  "Explain why connection state matters for a stateful firewall.",
  "How would a stateful firewall handle an unexpected packet?",
  "Describe the role of state tracking in firewall filtering.",
];

describe("review-orchestrator (Phase 9)", () => {
  let userId: string;
  let courseId: string;
  let conceptId: string;
  let otherConceptId: string;
  let chunkId: string;
  let promptIndex = 0;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-review-${suffix}@example.com` } });
    userId = user.id;

    const course = await prisma.course.create({ data: { userId, title: "Networking", knowledgeStatus: "READY" } });
    courseId = course.id;

    const concept = await prisma.concept.create({
      data: { courseId, name: "Firewalls", normalizedName: "firewalls", description: "Filters network traffic.", difficulty: 2 },
    });
    conceptId = concept.id;

    const otherConcept = await prisma.concept.create({
      data: { courseId, name: "Ports", normalizedName: "ports", description: "Numbered network endpoints.", difficulty: 1 },
    });
    otherConceptId = otherConcept.id;

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

    const portsChunk = await prisma.documentChunk.create({
      data: {
        documentId: document.id,
        text: "Ports are numbered endpoints (0-65535) that identify a specific process on a networked device.",
        chunkIndex: 1,
        tokenCount: 20,
      },
    });
    await prisma.conceptSource.create({
      data: { conceptId: otherConceptId, documentChunkId: portsChunk.id, evidence: "Ports are numbered endpoints." },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  beforeEach(async () => {
    vi.mocked(extractStructured).mockReset();
    vi.mocked(extractStructured).mockImplementation(async (options: { requestType: string; prompt?: string }) => {
      if (options.requestType === "QUESTION_GENERATION" || options.requestType === "REMEDIATION") {
        // Ground the mock's answer in whatever chunk(s) were actually cited in this prompt, rather than a single
        // hardcoded chunk id — otherwise generation for a second concept (a different set of source chunks) would
        // always fail the grounding check and this mock would silently only work for the first concept ever tested.
        const citedChunkIds = [...(options.prompt ?? "").matchAll(/Chunk (\S+):/g)].map((m) => m[1]);
        return {
          data: {
            canGenerate: true,
            prompt: QUESTION_PROMPTS[promptIndex++ % QUESTION_PROMPTS.length],
            expectedAnswer: "Connection state.",
            rubric: ["Mentions connection state"],
            sourceChunkIds: citedChunkIds.length > 0 ? citedChunkIds : [chunkId],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      if (options.requestType === "ANSWER_EVALUATION") {
        return { data: currentEvaluation(), usage: { inputTokens: 1, outputTokens: 1 } };
      }
      throw new Error(`unmocked requestType ${options.requestType}`);
    });

    // Clean review state between tests, keep concepts/course/mastery seeding per-test.
    await prisma.reviewEvent.deleteMany({ where: { userId } });
    await prisma.reviewItem.deleteMany({ where: { userId } });
    await prisma.studySession.deleteMany({ where: { userId } });
    await prisma.answer.deleteMany({ where: { userId } });
    await prisma.learningAttempt.deleteMany({ where: { userId } });
    await prisma.studentConceptMastery.deleteMany({ where: { userId } });
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

  async function seedExposedConcept(id: string, overrides: Partial<{ overallMastery: number }> = {}) {
    await prisma.studentConceptMastery.create({
      data: { userId, conceptId: id, exposureCount: 3, attemptCount: 3, overallMastery: overrides.overallMastery ?? 0.5 },
    });
  }

  async function seedDueReviewItem(id: string, overdueDays: number) {
    const nextReviewAt = new Date(Date.now() - overdueDays * 24 * 60 * 60 * 1000);
    return prisma.reviewItem.create({
      data: { userId, courseId, conceptId: id, status: "REVIEW", interval: 5, stability: 5, difficulty: 3, nextReviewAt },
    });
  }

  describe("ensureReviewItemsForCourse (spec §3 — lazy creation, mirrors StudentConceptMastery)", () => {
    it("creates a ReviewItem only for concepts with real exposure, never the whole course upfront", async () => {
      await seedExposedConcept(conceptId);
      await ensureReviewItemsForCourse(userId, courseId);

      const items = await prisma.reviewItem.findMany({ where: { userId, courseId } });
      expect(items).toHaveLength(1);
      expect(items[0].conceptId).toBe(conceptId);
      expect(items[0].status).toBe("NEW");
    });

    it("is idempotent — calling it twice never creates duplicate rows (unique userId+conceptId)", async () => {
      await seedExposedConcept(conceptId);
      await ensureReviewItemsForCourse(userId, courseId);
      await ensureReviewItemsForCourse(userId, courseId);

      const items = await prisma.reviewItem.findMany({ where: { userId, courseId, conceptId } });
      expect(items).toHaveLength(1);
    });
  });

  describe("due / overdue detection (spec §22)", () => {
    it("getDueReviews returns only items whose nextReviewAt has passed, most-overdue first", async () => {
      await seedExposedConcept(conceptId);
      await seedExposedConcept(otherConceptId);
      await seedDueReviewItem(conceptId, 5);
      await seedDueReviewItem(otherConceptId, 1);

      const due = await getDueReviews(userId, courseId);
      const conceptIds = due.map((d) => d.conceptId);
      expect(conceptIds).toContain(conceptId);
      expect(conceptIds).toContain(otherConceptId);
      expect(due[0].conceptId).toBe(conceptId); // most overdue (5 days) first
      expect(due[0].overdueDays).toBeGreaterThan(due[1].overdueDays);
    });

    it("getReviewState reports dueCount/overdueCount correctly and never double-counts", async () => {
      await seedExposedConcept(conceptId);
      await seedExposedConcept(otherConceptId);
      await seedDueReviewItem(conceptId, 3);
      await seedDueReviewItem(otherConceptId, 0.5); // due, but under 1 full day overdue

      const state = await getReviewState(userId, courseId);
      expect(state).not.toBeNull();
      expect(state!.dueCount).toBe(2);
      expect(state!.overdueCount).toBe(1);
    });
  });

  describe("getOrStartReviewSession (spec §10, §13)", () => {
    it("throws NoReviewsDueError when nothing is due", async () => {
      await seedExposedConcept(conceptId);
      await ensureReviewItemsForCourse(userId, courseId); // seeds with nextReviewAt tomorrow, not due yet

      await expect(getOrStartReviewSession(userId, courseId)).rejects.toThrow(NoReviewsDueError);
    });

    it("starts a REVIEW-mode session targeting the most-overdue due concept, reusing Active Recall's question generator", async () => {
      await seedExposedConcept(conceptId);
      await seedDueReviewItem(conceptId, 2);

      const result = await getOrStartReviewSession(userId, courseId);
      expect(result).not.toBeNull();
      expect(result!.session.status).toBe("ACTIVE");
      expect(result!.currentSessionQuestion?.question.conceptId).toBe(conceptId);
      expect(result!.dueCount).toBe(1);

      const persisted = await prisma.studySession.findUnique({ where: { id: result!.session.id } });
      expect(persisted?.mode).toBe("REVIEW");
    });

    it("resuming returns the same active session instead of starting a second one", async () => {
      await seedExposedConcept(conceptId);
      await seedDueReviewItem(conceptId, 2);

      const first = await getOrStartReviewSession(userId, courseId);
      const second = await getOrStartReviewSession(userId, courseId);
      expect(second!.session.id).toBe(first!.session.id);

      const activeId = await getActiveReviewSessionId(userId, courseId);
      expect(activeId).toBe(first!.session.id);
    });
  });

  describe("full loop: review -> evaluation -> recordLearningOutcome() -> review event -> nextReviewAt (spec §9, integration scenario)", () => {
    it("rating GOOD after a correct answer records evidence, creates one ReviewEvent, and pushes nextReviewAt into the future", async () => {
      await seedExposedConcept(conceptId);
      const seeded = await seedDueReviewItem(conceptId, 1);
      const previousInterval = seeded.interval;

      const start = await getOrStartReviewSession(userId, courseId);
      const sessionId = start!.session.id;
      const sessionQuestionId = start!.currentSessionQuestion!.id;

      evaluationOverride = { score: 0.9, correctness: "CORRECT" };
      await submitAnswer({ sessionId, userId, sessionQuestionId, answerText: "It tracks connection state." });
      const answerResult = await evaluateSubmittedAnswer({ sessionId, userId, sessionQuestionId });
      expect(answerResult.answer.attemptId).not.toBeNull();

      const attemptCountBefore = await prisma.learningAttempt.count({ where: { userId, conceptId } });
      expect(attemptCountBefore).toBe(1);

      const rating = await submitReviewRating({ sessionId, userId, sessionQuestionId, outcome: "GOOD" });
      expect(rating.alreadyRated).toBe(false);
      expect(rating.event.outcome).toBe("GOOD");
      expect(rating.event.previousInterval).toBe(previousInterval);
      expect(rating.event.newInterval).toBeGreaterThan(0);
      expect(rating.reviewItem.nextReviewAt.getTime()).toBeGreaterThan(Date.now());
      expect(rating.reviewItem.repetitionCount).toBe(1);
      expect(rating.reviewItem.status).toBe("LEARNING");

      const events = await prisma.reviewEvent.findMany({ where: { reviewItemId: rating.reviewItem.id } });
      expect(events).toHaveLength(1);
      expect(events[0].attemptId).toBe(answerResult.answer.attemptId);
    });

    it("rating AGAIN increases lapseCount and reschedules the item for the very next day", async () => {
      await seedExposedConcept(conceptId);
      await seedDueReviewItem(conceptId, 1);

      const start = await getOrStartReviewSession(userId, courseId);
      const sessionId = start!.session.id;
      const sessionQuestionId = start!.currentSessionQuestion!.id;

      evaluationOverride = { score: 0.1, correctness: "INCORRECT" };
      await submitAnswer({ sessionId, userId, sessionQuestionId, answerText: "Not sure." });
      await evaluateSubmittedAnswer({ sessionId, userId, sessionQuestionId });

      const rating = await submitReviewRating({ sessionId, userId, sessionQuestionId, outcome: "AGAIN" });
      expect(rating.reviewItem.lapseCount).toBe(1);
      expect(rating.reviewItem.repetitionCount).toBe(0);
      expect(rating.event.newInterval).toBe(1);
    });
  });

  describe("idempotency (spec §21) — duplicate review submission protection", () => {
    it("submitting the same rating twice returns the original result and never creates a second ReviewEvent or reschedules twice", async () => {
      await seedExposedConcept(conceptId);
      await seedDueReviewItem(conceptId, 1);

      const start = await getOrStartReviewSession(userId, courseId);
      const sessionId = start!.session.id;
      const sessionQuestionId = start!.currentSessionQuestion!.id;

      evaluationOverride = { score: 0.9, correctness: "CORRECT" };
      await submitAnswer({ sessionId, userId, sessionQuestionId, answerText: "It tracks connection state." });
      await evaluateSubmittedAnswer({ sessionId, userId, sessionQuestionId });

      const first = await submitReviewRating({ sessionId, userId, sessionQuestionId, outcome: "GOOD" });
      const second = await submitReviewRating({ sessionId, userId, sessionQuestionId, outcome: "EASY" }); // even a different claimed outcome must not double-apply

      expect(first.alreadyRated).toBe(false);
      expect(second.alreadyRated).toBe(true);
      expect(second.event.id).toBe(first.event.id);
      expect(second.reviewItem.nextReviewAt.getTime()).toBe(first.reviewItem.nextReviewAt.getTime());

      const events = await prisma.reviewEvent.findMany({ where: { reviewItemId: first.reviewItem.id } });
      expect(events).toHaveLength(1);
    });
  });

  describe("session progression", () => {
    it("nextReviewQuestion refuses to advance until the current question has been rated", async () => {
      await seedExposedConcept(conceptId);
      await seedExposedConcept(otherConceptId);
      await seedDueReviewItem(conceptId, 3);
      await seedDueReviewItem(otherConceptId, 1);

      const start = await getOrStartReviewSession(userId, courseId);
      const sessionId = start!.session.id;
      const sessionQuestionId = start!.currentSessionQuestion!.id;

      evaluationOverride = { score: 0.9, correctness: "CORRECT" };
      await submitAnswer({ sessionId, userId, sessionQuestionId, answerText: "It tracks connection state." });
      await evaluateSubmittedAnswer({ sessionId, userId, sessionQuestionId });

      await expect(nextReviewQuestion(sessionId, userId)).rejects.toThrow(ReviewNotRatedError);

      await submitReviewRating({ sessionId, userId, sessionQuestionId, outcome: "GOOD" });
      const next = await nextReviewQuestion(sessionId, userId);
      expect(next.sessionQuestion.question.conceptId).toBe(otherConceptId);
    });

    it("completeReviewSession tallies AGAIN/HARD/GOOD/EASY from this session's own rated attempts only", async () => {
      await seedExposedConcept(conceptId);
      await seedDueReviewItem(conceptId, 1);

      const start = await getOrStartReviewSession(userId, courseId);
      const sessionId = start!.session.id;
      const sessionQuestionId = start!.currentSessionQuestion!.id;

      evaluationOverride = { score: 0.9, correctness: "CORRECT" };
      await submitAnswer({ sessionId, userId, sessionQuestionId, answerText: "It tracks connection state." });
      await evaluateSubmittedAnswer({ sessionId, userId, sessionQuestionId });
      await submitReviewRating({ sessionId, userId, sessionQuestionId, outcome: "EASY" });

      const summary = await completeReviewSession(sessionId, userId);
      expect(summary).not.toBeNull();
      expect(summary!.reviewed).toBe(1);
      expect(summary!.easy).toBe(1);
      expect(summary!.again + summary!.hard + summary!.good).toBe(0);
      expect(summary!.nextReviewAt).not.toBeNull();
    });
  });
});
