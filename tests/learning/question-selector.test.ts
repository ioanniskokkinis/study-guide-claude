import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { selectNextLearningTarget } from "@/lib/learning/question-selector";

describe("selectNextLearningTarget", () => {
  let userId: string;
  let courseId: string;
  let tcpId: string;
  let portsId: string;
  let firewallsId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-selector-${suffix}@example.com` } });
    userId = user.id;
    const course = await prisma.course.create({ data: { userId, title: "Networking" } });
    courseId = course.id;

    const tcp = await prisma.concept.create({ data: { courseId, name: "TCP", normalizedName: "tcp", difficulty: 2 } });
    const ports = await prisma.concept.create({ data: { courseId, name: "Ports", normalizedName: "ports", difficulty: 2 } });
    const firewalls = await prisma.concept.create({
      data: { courseId, name: "Firewalls", normalizedName: "firewalls", difficulty: 3 },
    });
    tcpId = tcp.id;
    portsId = ports.id;
    firewallsId = firewalls.id;

    // Ports is a prerequisite of Firewalls — the TCP/Ports/Firewalls example from spec §8.
    await prisma.conceptRelationship.create({
      data: {
        sourceConceptId: ports.id,
        targetConceptId: firewalls.id,
        relationshipType: "prerequisite",
        confidence: 0.9,
        evidence: "Firewalls filter by port.",
      },
    });

    await prisma.studentConceptMastery.createMany({
      data: [
        { userId, conceptId: tcp.id, overallMastery: 0.9, exposureCount: 5, successCount: 4, status: "STRONG" },
        { userId, conceptId: ports.id, overallMastery: 0.35, exposureCount: 3, status: "LEARNING" },
        { userId, conceptId: firewalls.id, overallMastery: 0.2, exposureCount: 3, status: "LEARNING" },
      ],
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("prioritizes a weak concept that is also a prerequisite of another weak concept over the weak concept itself", async () => {
    const target = await selectNextLearningTarget({ userId, courseId });
    expect(target).not.toBeNull();
    expect(target!.conceptId).toBe(portsId);
    expect(target!.reason.toLowerCase()).toContain("prerequisite");
  });

  it("deprioritizes an already-strong/mastered concept relative to weak ones", async () => {
    // With Ports and Firewalls both weak/prerequisite-gapped, TCP (strong) should never be picked.
    const target = await selectNextLearningTarget({ userId, courseId });
    expect(target!.conceptId).not.toBe(tcpId);
  });

  it("suggests a difficulty derived from the concept's own history/fallback", async () => {
    const target = await selectNextLearningTarget({ userId, courseId });
    expect(target!.suggestedDifficulty).toBeGreaterThanOrEqual(1);
    expect(target!.suggestedDifficulty).toBeLessThanOrEqual(5);
  });

  it("forceConceptId overrides scoring and targets the given concept directly", async () => {
    const target = await selectNextLearningTarget({ userId, courseId, forceConceptId: firewallsId });
    expect(target!.conceptId).toBe(firewallsId);
    expect(target!.reason.toLowerCase()).toContain("prerequisite");
  });

  it("returns null for a course with no concepts", async () => {
    const emptyCourse = await prisma.course.create({ data: { userId, title: "Empty course" } });
    const target = await selectNextLearningTarget({ userId, courseId: emptyCourse.id });
    expect(target).toBeNull();
  });

  it("picks the weak concept once no prerequisite-gap signal exists", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const course = await prisma.course.create({ data: { userId, title: `Simple ${suffix}` } });
    const strong = await prisma.concept.create({ data: { courseId: course.id, name: "Strong", normalizedName: "strong" } });
    const weak = await prisma.concept.create({ data: { courseId: course.id, name: "Weak", normalizedName: "weak" } });

    await prisma.studentConceptMastery.createMany({
      data: [
        { userId, conceptId: strong.id, overallMastery: 0.92, exposureCount: 4, status: "MASTERED", successCount: 4 },
        { userId, conceptId: weak.id, overallMastery: 0.3, exposureCount: 3, status: "LEARNING" },
      ],
    });

    const target = await selectNextLearningTarget({ userId, courseId: course.id });
    expect(target!.conceptId).toBe(weak.id);
  });
});
