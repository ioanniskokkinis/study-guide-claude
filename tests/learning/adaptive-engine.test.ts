import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { getNextLearningAction, NoConceptsAvailableError } from "@/lib/learning/adaptive-engine";
import { getStudentLearningState } from "@/lib/learning/adaptive/student-state";
import { calculateConceptScores, generateCandidateActions, rankActions } from "@/lib/learning/adaptive-engine";

describe("adaptive engine (integration)", () => {
  let userId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-adaptive-${suffix}@example.com` } });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("throws NoConceptsAvailableError for a course with no knowledge graph", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const course = await prisma.course.create({ data: { userId, title: `Empty ${suffix}` } });
    await expect(getNextLearningAction({ userId, courseId: course.id })).rejects.toBeInstanceOf(
      NoConceptsAvailableError,
    );
  });

  it("prioritizes a weak concept over a mastered one, and every score stays in [0,1]", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const course = await prisma.course.create({ data: { userId, title: `Weak vs strong ${suffix}` } });
    const weak = await prisma.concept.create({ data: { courseId: course.id, name: "Weak", normalizedName: "weak" } });
    const strong = await prisma.concept.create({ data: { courseId: course.id, name: "Strong", normalizedName: "strong" } });

    await prisma.studentConceptMastery.createMany({
      data: [
        { userId, conceptId: weak.id, overallMastery: 0.15, exposureCount: 3, status: "LEARNING" },
        { userId, conceptId: strong.id, overallMastery: 0.95, exposureCount: 6, successCount: 6, status: "MASTERED" },
      ],
    });

    const { action } = await getNextLearningAction({ userId, courseId: course.id });
    expect(action.conceptId).toBe(weak.id);
    expect(action.priority).toBeGreaterThanOrEqual(0);
    expect(action.priority).toBeLessThanOrEqual(1);
    expect(action.difficulty).toBeGreaterThanOrEqual(1);
    expect(action.difficulty).toBeLessThanOrEqual(5);
  });

  it("logs every decision to AdaptiveDecisionLog", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const course = await prisma.course.create({ data: { userId, title: `Logged ${suffix}` } });
    const c1 = await prisma.concept.create({ data: { courseId: course.id, name: "C1", normalizedName: "c1" } });

    const before = await prisma.adaptiveDecisionLog.count({ where: { userId, courseId: course.id } });
    const { decisionLogId } = await getNextLearningAction({ userId, courseId: course.id });
    const after = await prisma.adaptiveDecisionLog.count({ where: { userId, courseId: course.id } });

    expect(after).toBe(before + 1);
    const log = await prisma.adaptiveDecisionLog.findUnique({ where: { id: decisionLogId } });
    expect(log?.conceptId).toBe(c1.id);
    expect(log?.accepted).toBeNull();
  });

  it("increases priority for a concept relevant to an imminent exam goal", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const course = await prisma.course.create({ data: { userId, title: `Exam ${suffix}` } });
    const target = await prisma.concept.create({ data: { courseId: course.id, name: "Target", normalizedName: "target" } });
    const other = await prisma.concept.create({ data: { courseId: course.id, name: "Other", normalizedName: "other" } });

    await prisma.studentConceptMastery.createMany({
      data: [
        { userId, conceptId: target.id, overallMastery: 0.4, exposureCount: 3, status: "LEARNING" },
        { userId, conceptId: other.id, overallMastery: 0.4, exposureCount: 3, status: "LEARNING" },
      ],
    });

    const withoutGoal = await getStudentLearningState(userId, course.id);
    const scoresWithout = calculateConceptScores(withoutGoal!);
    expect(scoresWithout.get(target.id)!.goalRelevance).toBe(0);

    await prisma.learningGoal.create({
      data: {
        userId,
        courseId: course.id,
        type: "EXAM",
        targetDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        targetConceptIds: [target.id],
      },
    });

    const withGoal = await getStudentLearningState(userId, course.id);
    const scoresWith = calculateConceptScores(withGoal!);
    expect(scoresWith.get(target.id)!.goalRelevance).toBeGreaterThan(0);
    expect(scoresWith.get(other.id)!.goalRelevance).toBe(0);
  });

  it("interleaving: does not keep recommending the same concept when a comparable alternative exists", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const course = await prisma.course.create({ data: { userId, title: `Interleave ${suffix}` } });
    const a = await prisma.concept.create({ data: { courseId: course.id, name: "A", normalizedName: "a" } });
    const b = await prisma.concept.create({ data: { courseId: course.id, name: "B", normalizedName: "b" } });

    // Equally weak, but A was just practiced repeatedly (with unremarkable, non-failing results — this test isolates the pure recency/interleaving signal from repeated-failure remediation).
    await prisma.studentConceptMastery.createMany({
      data: [
        { userId, conceptId: a.id, overallMastery: 0.3, exposureCount: 3, status: "LEARNING" },
        { userId, conceptId: b.id, overallMastery: 0.3, exposureCount: 3, status: "LEARNING" },
      ],
    });
    await prisma.learningAttempt.createMany({
      data: Array.from({ length: 3 }, () => ({
        userId,
        conceptId: a.id,
        activityType: "RECALL" as const,
        difficulty: 2,
        score: 0.5,
        correctness: 0.5,
      })),
    });

    const state = await getStudentLearningState(userId, course.id);
    const scores = calculateConceptScores(state!);
    const candidates = generateCandidateActions(state!, scores);
    const best = rankActions(candidates, state!);

    expect(best?.conceptId).toBe(b.id);
  });

  describe("end-to-end scenario (spec §46): TCP/IP -> TCP -> Ports -> Firewalls -> Network Attacks", () => {
    let course: { id: string };
    let tcpip: { id: string };
    let tcp: { id: string };
    let ports: { id: string };
    let firewalls: { id: string };
    let networkAttacks: { id: string };

    beforeAll(async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      course = await prisma.course.create({ data: { userId, title: `E2E scenario ${suffix}` } });
      tcpip = await prisma.concept.create({ data: { courseId: course.id, name: "TCP/IP", normalizedName: "tcp/ip" } });
      tcp = await prisma.concept.create({ data: { courseId: course.id, name: "TCP", normalizedName: "tcp" } });
      ports = await prisma.concept.create({ data: { courseId: course.id, name: "Ports", normalizedName: "ports" } });
      firewalls = await prisma.concept.create({ data: { courseId: course.id, name: "Firewalls", normalizedName: "firewalls" } });
      networkAttacks = await prisma.concept.create({
        data: { courseId: course.id, name: "Network Attacks", normalizedName: "network attacks" },
      });

      await prisma.conceptRelationship.createMany({
        data: [
          { sourceConceptId: tcpip.id, targetConceptId: tcp.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
          { sourceConceptId: tcp.id, targetConceptId: ports.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
          { sourceConceptId: ports.id, targetConceptId: firewalls.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
          {
            sourceConceptId: firewalls.id,
            targetConceptId: networkAttacks.id,
            relationshipType: "prerequisite",
            confidence: 0.9,
            evidence: "x",
          },
        ],
      });

      await prisma.studentConceptMastery.createMany({
        data: [
          { userId, conceptId: tcpip.id, overallMastery: 0.95, exposureCount: 6, successCount: 6, status: "MASTERED" },
          { userId, conceptId: tcp.id, overallMastery: 0.8, exposureCount: 5, successCount: 4, status: "STRONG" },
          { userId, conceptId: ports.id, overallMastery: 0.3, exposureCount: 3, status: "LEARNING" },
          { userId, conceptId: firewalls.id, overallMastery: 0.35, exposureCount: 3, status: "LEARNING" },
          { userId, conceptId: networkAttacks.id, overallMastery: 0.2, exposureCount: 2, status: "LEARNING" },
        ],
      });
    });

    it("step 1: Ports receives the recommendation via PREREQUISITE_REVIEW (it blocks Firewalls)", async () => {
      const { action } = await getNextLearningAction({ userId, courseId: course.id });
      expect(action.conceptId).toBe(ports.id);
      expect(action.actionType).toBe("PREREQUISITE_REVIEW");
    });

    it("step 2: after Ports improves past the threshold, Firewalls becomes the appropriate target", async () => {
      await prisma.studentConceptMastery.update({
        where: { userId_conceptId: { userId, conceptId: ports.id } },
        data: { overallMastery: 0.65, status: "STRONG", successCount: 3 },
      });
      await prisma.learningAttempt.createMany({
        data: Array.from({ length: 3 }, () => ({
          userId,
          conceptId: ports.id,
          activityType: "RECALL" as const,
          difficulty: 2,
          score: 0.9,
          correctness: 0.9,
        })),
      });

      const { action } = await getNextLearningAction({ userId, courseId: course.id });
      expect(action.conceptId).toBe(firewalls.id);
      expect(action.actionType).not.toBe("PREREQUISITE_REVIEW");
    });

    it("step 3: three failures on Firewalls trigger REMEDIATION", async () => {
      await prisma.learningAttempt.createMany({
        data: Array.from({ length: 3 }, () => ({
          userId,
          conceptId: firewalls.id,
          activityType: "RECALL" as const,
          difficulty: 2,
          score: 0.1,
          correctness: 0.1,
        })),
      });

      const { action } = await getNextLearningAction({ userId, courseId: course.id });
      expect(action.conceptId).toBe(firewalls.id);
      expect(action.actionType).toBe("REMEDIATION");
    });

    it("step 4: a failure on Ports drops it back below threshold, re-triggering PREREQUISITE_REVIEW", async () => {
      await prisma.studentConceptMastery.update({
        where: { userId_conceptId: { userId, conceptId: ports.id } },
        data: { overallMastery: 0.25, status: "LEARNING" },
      });
      await prisma.learningAttempt.create({
        data: { userId, conceptId: ports.id, activityType: "RECALL", difficulty: 2, score: 0.1, correctness: 0.1 },
      });

      const { action } = await getNextLearningAction({ userId, courseId: course.id });
      expect(action.conceptId).toBe(ports.id);
      expect(action.actionType).toBe("PREREQUISITE_REVIEW");
    });
  });
});
