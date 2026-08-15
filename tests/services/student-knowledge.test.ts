import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import {
  getCourseMastery,
  getKnowledgeSnapshot,
  getMastery,
  getPrerequisiteStatus,
  getStrongConcepts,
  getUnknownConcepts,
  getWeakConcepts,
} from "@/lib/services/student-knowledge";

describe("student-knowledge service", () => {
  let userId: string;
  let otherUserId: string;
  let courseId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-sk-${suffix}@example.com` } });
    userId = user.id;
    const otherUser = await prisma.user.create({ data: { email: `test-sk-other-${suffix}@example.com` } });
    otherUserId = otherUser.id;

    const course = await prisma.course.create({ data: { userId, title: "Networking" } });
    courseId = course.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  describe("getMastery / getCourseMastery — unknown is a valid answer", () => {
    it("returns null for a concept not owned by the caller", async () => {
      const concept = await prisma.concept.create({
        data: { courseId, name: "Private concept", normalizedName: "private concept" },
      });
      expect(await getMastery(otherUserId, concept.id)).toBeNull();
    });

    it("returns an UNKNOWN summary (not omission, not failure) for a concept with no mastery row", async () => {
      const concept = await prisma.concept.create({
        data: { courseId, name: "Never attempted", normalizedName: "never attempted" },
      });
      const mastery = await getMastery(userId, concept.id);
      expect(mastery).not.toBeNull();
      expect(mastery!.status).toBe("UNKNOWN");
      expect(mastery!.overallMastery).toBe(0);
      expect(mastery!.exposureCount).toBe(0);
    });

    it("excludes UNKNOWN (never-attempted) concepts from the course's overall mastery average", async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const course = await prisma.course.create({ data: { userId, title: `Isolated ${suffix}` } });
      const attempted = await prisma.concept.create({
        data: { courseId: course.id, name: "Attempted", normalizedName: "attempted" },
      });
      await prisma.concept.create({ data: { courseId: course.id, name: "Untouched", normalizedName: "untouched" } });
      await prisma.studentConceptMastery.create({
        data: { userId, conceptId: attempted.id, overallMastery: 0.9, exposureCount: 3, status: "STRONG" },
      });

      const result = await getCourseMastery(userId, course.id);
      // If the UNKNOWN concept were averaged in, this would be 0.45, not 0.9.
      expect(result!.overallMastery).toBe(0.9);
      expect(result!.concepts).toHaveLength(2);
    });
  });

  describe("bucket queries", () => {
    let strongConceptId: string;
    let weakConceptId: string;
    let unknownConceptId: string;

    beforeAll(async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const course = await prisma.course.create({ data: { userId, title: `Buckets ${suffix}` } });
      courseId = course.id;

      const strong = await prisma.concept.create({ data: { courseId, name: "TCP", normalizedName: "tcp" } });
      const weak = await prisma.concept.create({ data: { courseId, name: "Firewalls", normalizedName: "firewalls" } });
      const unknown = await prisma.concept.create({ data: { courseId, name: "IDS/IPS", normalizedName: "ids/ips" } });
      strongConceptId = strong.id;
      weakConceptId = weak.id;
      unknownConceptId = unknown.id;

      await prisma.studentConceptMastery.createMany({
        data: [
          { userId, conceptId: strong.id, overallMastery: 0.92, exposureCount: 5, successCount: 4, status: "STRONG" },
          { userId, conceptId: weak.id, overallMastery: 0.31, exposureCount: 4, status: "LEARNING" },
        ],
      });
    });

    it("getStrongConcepts returns only STRONG/MASTERED concepts", async () => {
      const strong = await getStrongConcepts(userId, courseId);
      expect(strong!.map((c) => c.conceptId)).toContain(strongConceptId);
      expect(strong!.map((c) => c.conceptId)).not.toContain(weakConceptId);
    });

    it("getWeakConcepts returns only LEARNING/NEEDS_REMEDIATION concepts", async () => {
      const weak = await getWeakConcepts(userId, courseId);
      expect(weak!.map((c) => c.conceptId)).toContain(weakConceptId);
      expect(weak!.map((c) => c.conceptId)).not.toContain(strongConceptId);
    });

    it("getUnknownConcepts returns concepts with no evidence at all", async () => {
      const unknown = await getUnknownConcepts(userId, courseId);
      expect(unknown!.map((c) => c.conceptId)).toContain(unknownConceptId);
      expect(unknown!.map((c) => c.conceptId)).not.toContain(strongConceptId);
    });
  });

  describe("getKnowledgeSnapshot — prerequisite gap detection", () => {
    it("flags a weak concept that is also a prerequisite of another weak concept (TCP/Ports/Firewalls example)", async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const course = await prisma.course.create({ data: { userId, title: `Snapshot ${suffix}` } });

      const tcp = await prisma.concept.create({ data: { courseId: course.id, name: "TCP", normalizedName: "tcp" } });
      const ports = await prisma.concept.create({ data: { courseId: course.id, name: "Ports", normalizedName: "ports" } });
      const firewalls = await prisma.concept.create({
        data: { courseId: course.id, name: "Firewalls", normalizedName: "firewalls" },
      });

      await prisma.conceptRelationship.create({
        data: {
          sourceConceptId: ports.id,
          targetConceptId: firewalls.id,
          relationshipType: "prerequisite",
          confidence: 0.9,
          evidence: "Firewalls rely on port knowledge.",
        },
      });

      await prisma.studentConceptMastery.createMany({
        data: [
          { userId, conceptId: tcp.id, overallMastery: 0.9, exposureCount: 4, status: "STRONG" },
          { userId, conceptId: ports.id, overallMastery: 0.35, exposureCount: 3, status: "LEARNING" },
          { userId, conceptId: firewalls.id, overallMastery: 0.2, exposureCount: 3, status: "LEARNING" },
        ],
      });

      const snapshot = await getKnowledgeSnapshot(userId, course.id);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.prerequisiteGaps).toHaveLength(1);
      expect(snapshot!.prerequisiteGaps[0].prerequisite.conceptId).toBe(ports.id);
      expect(snapshot!.prerequisiteGaps[0].concept.conceptId).toBe(firewalls.id);
    });
  });

  describe("getPrerequisiteStatus — recursion and cycle protection", () => {
    it("recursively resolves a multi-level prerequisite chain", async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const course = await prisma.course.create({ data: { userId, title: `Chain ${suffix}` } });

      const a = await prisma.concept.create({ data: { courseId: course.id, name: "A", normalizedName: "a" } });
      const b = await prisma.concept.create({ data: { courseId: course.id, name: "B", normalizedName: "b" } });
      const c = await prisma.concept.create({ data: { courseId: course.id, name: "C", normalizedName: "c" } });

      // A is a prerequisite of B, B is a prerequisite of C.
      await prisma.conceptRelationship.createMany({
        data: [
          { sourceConceptId: a.id, targetConceptId: b.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
          { sourceConceptId: b.id, targetConceptId: c.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
        ],
      });

      const status = await getPrerequisiteStatus(userId, c.id);
      expect(status!.concept.id).toBe(c.id);
      expect(status!.prerequisites).toHaveLength(1);
      expect(status!.prerequisites[0].concept.id).toBe(b.id);
      expect(status!.prerequisites[0].prerequisites).toHaveLength(1);
      expect(status!.prerequisites[0].prerequisites[0].concept.id).toBe(a.id);
    });

    it("terminates instead of infinitely recursing on a prerequisite cycle", async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const course = await prisma.course.create({ data: { userId, title: `Cycle ${suffix}` } });

      const a = await prisma.concept.create({ data: { courseId: course.id, name: "A", normalizedName: "a" } });
      const b = await prisma.concept.create({ data: { courseId: course.id, name: "B", normalizedName: "b" } });
      const c = await prisma.concept.create({ data: { courseId: course.id, name: "C", normalizedName: "c" } });

      // A -> B -> C -> A: a cycle.
      await prisma.conceptRelationship.createMany({
        data: [
          { sourceConceptId: a.id, targetConceptId: b.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
          { sourceConceptId: b.id, targetConceptId: c.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
          { sourceConceptId: c.id, targetConceptId: a.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
        ],
      });

      const status = await getPrerequisiteStatus(userId, c.id);
      expect(status!.concept.id).toBe(c.id);
      // C -> B -> A -> (C already on this path, cut off)
      expect(status!.prerequisites[0].concept.id).toBe(b.id);
      expect(status!.prerequisites[0].prerequisites[0].concept.id).toBe(a.id);
      expect(status!.prerequisites[0].prerequisites[0].prerequisites).toHaveLength(0);
    });

    it("allows a shared ancestor to appear via two different paths in a diamond-shaped graph (not treated as a cycle)", async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const course = await prisma.course.create({ data: { userId, title: `Diamond ${suffix}` } });

      const d = await prisma.concept.create({ data: { courseId: course.id, name: "D", normalizedName: "d" } });
      const a = await prisma.concept.create({ data: { courseId: course.id, name: "A", normalizedName: "a" } });
      const b = await prisma.concept.create({ data: { courseId: course.id, name: "B", normalizedName: "b" } });
      const c = await prisma.concept.create({ data: { courseId: course.id, name: "C", normalizedName: "c" } });

      // D is a prerequisite of both A and B; both A and B are prerequisites of C.
      await prisma.conceptRelationship.createMany({
        data: [
          { sourceConceptId: d.id, targetConceptId: a.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
          { sourceConceptId: d.id, targetConceptId: b.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
          { sourceConceptId: a.id, targetConceptId: c.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
          { sourceConceptId: b.id, targetConceptId: c.id, relationshipType: "prerequisite", confidence: 0.9, evidence: "x" },
        ],
      });

      const status = await getPrerequisiteStatus(userId, c.id);
      const branchConceptIds = status!.prerequisites.map((p) => p.concept.id).sort();
      expect(branchConceptIds).toEqual([a.id, b.id].sort());

      for (const branch of status!.prerequisites) {
        expect(branch.prerequisites.map((p) => p.concept.id)).toEqual([d.id]);
      }
    });

    it("returns null for a concept not owned by the caller", async () => {
      const concept = await prisma.concept.create({
        data: { courseId, name: "Not mine", normalizedName: "not mine" },
      });
      expect(await getPrerequisiteStatus(otherUserId, concept.id)).toBeNull();
    });
  });
});
