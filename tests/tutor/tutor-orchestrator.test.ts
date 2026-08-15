import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", () => ({ extractStructured: vi.fn() }));

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import {
  requestTeachBack,
  requestTutorHint,
  startTutorSession,
  submitTutorMessage,
} from "@/lib/tutor/tutor-orchestrator";

interface MockCallOptions {
  requestType: string;
}

let nextEvaluation: Record<string, unknown> = {};
let nextTeachBack: Record<string, unknown> = {};

function resetMocks() {
  nextEvaluation = {
    classification: "CORRECT",
    confidence: 0.8,
    misconceptionDescription: null,
    severity: null,
    missingConcepts: [],
    recommendedAction: "ASK_FOLLOWUP",
    feedback: "Good.",
  };
  nextTeachBack = {
    overall: "CORRECT",
    correctElements: ["core idea"],
    missingElements: [],
    misconceptions: [],
    correctness: 0.9,
    completeness: 0.9,
    conceptualAccuracy: 0.9,
    suggestedFollowup: "Try a transfer question.",
  };

  vi.mocked(extractStructured).mockImplementation(async (options: unknown) => {
    const { requestType } = options as MockCallOptions;
    const usage = { inputTokens: 1, outputTokens: 1 };
    switch (requestType) {
      case "TUTOR_RESPONSE_EVALUATION":
        return { data: nextEvaluation, usage };
      case "TUTOR_SOCRATIC_MESSAGE":
        return { data: { message: "Mock Socratic question?" }, usage };
      case "TUTOR_HINT":
        return { data: { message: "Mock hint." }, usage };
      case "TUTOR_EXPLANATION":
        return { data: { coreIdea: "Core idea.", example: "An example.", connection: "Connects back.", checkQuestion: "Check?" }, usage };
      case "TUTOR_TEACH_BACK_EVALUATION":
        return { data: nextTeachBack, usage };
      default:
        throw new Error(`unmocked requestType ${requestType}`);
    }
  });
}

describe("tutor orchestrator (integration)", () => {
  let userId: string;
  let courseId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-tutor-${suffix}@example.com` } });
    userId = user.id;
    const course = await prisma.course.create({ data: { userId, title: `Tutor ${suffix}` } });
    courseId = course.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  beforeEach(() => {
    vi.mocked(extractStructured).mockReset();
    resetMocks();
  });

  it("starts a Socratic session with an opening question", async () => {
    const concept = await prisma.concept.create({ data: { courseId, name: "TCP Basics", normalizedName: "tcp basics" } });

    const { session, messages } = await startTutorSession({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });
    expect(session.mode).toBe("SOCRATIC");
    expect(session.status).toBe("ACTIVE");
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("TUTOR");
    expect(messages[0].messageType).toBe("QUESTION");
  });

  it("resumes an existing active session instead of creating a duplicate", async () => {
    const concept = await prisma.concept.create({ data: { courseId, name: "Resumable", normalizedName: "resumable" } });
    const first = await startTutorSession({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });
    const second = await startTutorSession({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });
    expect(second.session.id).toBe(first.session.id);
  });

  it("a correct response advances the conversation and records mastery evidence", async () => {
    const concept = await prisma.concept.create({ data: { courseId, name: "Ports", normalizedName: "ports-o" } });
    const { session } = await startTutorSession({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });

    nextEvaluation.classification = "CORRECT";
    const result = await submitTutorMessage({ sessionId: session.id, userId, content: "It identifies a service." });

    expect(["ASK_FOLLOWUP", "DEEPEN", "INCREASE_DIFFICULTY"]).toContain(result.session.currentStep);
    const attempts = await prisma.learningAttempt.count({ where: { userId, conceptId: concept.id } });
    expect(attempts).toBe(1);
    const mastery = await prisma.studentConceptMastery.findUnique({ where: { userId_conceptId: { userId, conceptId: concept.id } } });
    expect(mastery?.exposureCount).toBe(1);
  });

  it("hints escalate HINT_1 -> HINT_2 -> HINT_3 -> REVEAL across four requests, tracking hintsUsedTotal", async () => {
    const concept = await prisma.concept.create({ data: { courseId, name: "Escalating", normalizedName: "escalating" } });
    const { session } = await startTutorSession({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });

    const r1 = await requestTutorHint(session.id, userId);
    expect(r1.session.hintLevel).toBe(1);
    expect(r1.message.messageType).toBe("HINT");

    const r2 = await requestTutorHint(session.id, userId);
    expect(r2.session.hintLevel).toBe(2);

    const r3 = await requestTutorHint(session.id, userId);
    expect(r3.session.hintLevel).toBe(3);

    const r4 = await requestTutorHint(session.id, userId);
    expect(r4.session.hintLevel).toBe(4);
    expect(r4.message.messageType).toBe("EXPLANATION");
    expect(r4.session.answerRevealed).toBe(true);
    expect(r4.session.hintsUsedTotal).toBe(4);
  });

  it("explicit 'I don't know' does not record mastery evidence and gives a hint instead", async () => {
    const concept = await prisma.concept.create({ data: { courseId, name: "Uncertain", normalizedName: "uncertain" } });
    const { session } = await startTutorSession({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });

    const result = await submitTutorMessage({ sessionId: session.id, userId, content: "I don't know" });
    expect(result.message.messageType).toBe("HINT");
    const attempts = await prisma.learningAttempt.count({ where: { userId, conceptId: concept.id } });
    expect(attempts).toBe(0);
  });

  it("explicit 'just tell me' reveals without evidence, and the follow-up retrieval question counts independently", async () => {
    const concept = await prisma.concept.create({ data: { courseId, name: "Revealed", normalizedName: "revealed" } });
    const { session } = await startTutorSession({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });

    const reveal = await submitTutorMessage({ sessionId: session.id, userId, content: "Just tell me" });
    expect(reveal.message.messageType).toBe("EXPLANATION");
    expect(reveal.session.answerRevealed).toBe(true);
    let attempts = await prisma.learningAttempt.count({ where: { userId, conceptId: concept.id } });
    expect(attempts).toBe(0);

    nextEvaluation.classification = "CORRECT";
    const followUp = await submitTutorMessage({ sessionId: reveal.session.id, userId, content: "Ports identify services." });
    expect(followUp.session.answerRevealed).toBe(false);
    attempts = await prisma.learningAttempt.count({ where: { userId, conceptId: concept.id } });
    expect(attempts).toBe(1);
  });

  it("a misconception with a blocked prerequisite redirects to the prerequisite and records the misconception against the original concept", async () => {
    const prereq = await prisma.concept.create({ data: { courseId, name: "Ports Prereq", normalizedName: "ports prereq" } });
    const target = await prisma.concept.create({ data: { courseId, name: "Firewalls Target", normalizedName: "firewalls target" } });
    await prisma.conceptRelationship.create({
      data: { sourceConceptId: prereq.id, targetConceptId: target.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
    });
    await prisma.studentConceptMastery.createMany({
      data: [
        { userId, conceptId: prereq.id, overallMastery: 0.15, exposureCount: 3, status: "LEARNING" },
        { userId, conceptId: target.id, overallMastery: 0.3, exposureCount: 3, status: "LEARNING" },
      ],
    });

    const { session } = await startTutorSession({ userId, courseId, conceptId: target.id, mode: "SOCRATIC" });

    nextEvaluation.classification = "MISCONCEPTION";
    nextEvaluation.misconceptionDescription = "Thinks a firewall assigns ports.";
    nextEvaluation.severity = "HIGH";
    const result = await submitTutorMessage({ sessionId: session.id, userId, content: "A firewall assigns ports to services." });

    expect(result.session.currentStep).toBe("CHECK_PREREQUISITE");
    expect(result.session.conceptId).toBe(target.id);

    const misconception = await prisma.studentMisconception.findFirst({ where: { userId, conceptId: target.id } });
    expect(misconception).not.toBeNull();
    expect(misconception?.severity).toBe("HIGH");
  });

  it("teach-back mode: a strong explanation records TEACH_BACK evidence and deepens", async () => {
    const concept = await prisma.concept.create({ data: { courseId, name: "TCP TeachBack", normalizedName: "tcp teachback" } });
    const { session } = await startTutorSession({ userId, courseId, conceptId: concept.id, mode: "TEACH_BACK" });

    nextTeachBack = {
      overall: "CORRECT",
      correctElements: ["connection-oriented"],
      missingElements: [],
      misconceptions: [],
      correctness: 0.95,
      completeness: 0.9,
      conceptualAccuracy: 0.95,
      suggestedFollowup: "Try applying it.",
    };
    const result = await submitTutorMessage({
      sessionId: session.id,
      userId,
      content: "TCP is connection-oriented and guarantees ordered, reliable delivery.",
    });

    expect(result.session.currentStep).toBe("DEEPEN");
    const attempt = await prisma.learningAttempt.findFirst({ where: { userId, conceptId: concept.id } });
    expect(attempt?.activityType).toBe("TEACH_BACK");
  });

  it("requestTeachBack switches an in-progress session into TEACH_BACK mode", async () => {
    const concept = await prisma.concept.create({ data: { courseId, name: "Switchable", normalizedName: "switchable" } });
    const { session } = await startTutorSession({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });

    const result = await requestTeachBack(session.id, userId);
    expect(result.session.mode).toBe("TEACH_BACK");
    expect(result.message.messageType).toBe("TEACH_BACK_PROMPT");
  });

  it("a session completes after two independent correct answers with no active misconception, and mastery is reflected in the outcome", async () => {
    const concept = await prisma.concept.create({ data: { courseId, name: "Completable", normalizedName: "completable" } });
    const { session } = await startTutorSession({ userId, courseId, conceptId: concept.id, mode: "SOCRATIC" });

    nextEvaluation.classification = "CORRECT";
    const first = await submitTutorMessage({ sessionId: session.id, userId, content: "Correct answer one." });
    expect(first.session.status).toBe("ACTIVE");

    const second = await submitTutorMessage({ sessionId: session.id, userId, content: "Correct answer two." });
    expect(second.session.status).toBe("COMPLETED");
    expect(second.session.completedAt).not.toBeNull();

    const outcome = await prisma.tutorSessionOutcome.findUnique({ where: { sessionId: session.id } });
    expect(outcome).not.toBeNull();
    expect(outcome?.masteryDelta).not.toBeNull();
  });
});
