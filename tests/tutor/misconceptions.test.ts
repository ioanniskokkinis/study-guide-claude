import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import {
  hasActiveHighSeverityMisconception,
  recordIndependentCorrectEvidence,
  recordMisconceptionDetection,
} from "@/lib/tutor/misconceptions";
import { MISCONCEPTION_RESOLUTION_EVIDENCE_COUNT } from "@/lib/tutor/config";

describe("hasActiveHighSeverityMisconception (pure)", () => {
  it("is false for an empty list", () => {
    expect(hasActiveHighSeverityMisconception([])).toBe(false);
  });

  it("is false when only LOW/MEDIUM misconceptions are active", () => {
    expect(
      hasActiveHighSeverityMisconception([{ id: "1", description: "x", severity: "MEDIUM", confidence: 0.5, occurrenceCount: 1, correctSinceCount: 0 }]),
    ).toBe(false);
  });

  it("is true when a HIGH or CRITICAL misconception is active", () => {
    expect(
      hasActiveHighSeverityMisconception([{ id: "1", description: "x", severity: "HIGH", confidence: 0.9, occurrenceCount: 1, correctSinceCount: 0 }]),
    ).toBe(true);
  });
});

describe("misconception persistence (spec §12-13)", () => {
  let userId: string;
  let conceptId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `test-misconception-${suffix}@example.com` } });
    userId = user.id;
    const course = await prisma.course.create({ data: { userId, title: `Misconception ${suffix}` } });
    const concept = await prisma.concept.create({ data: { courseId: course.id, name: "Firewalls", normalizedName: "firewalls" } });
    conceptId = concept.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("creates a new StudentMisconception on first detection", async () => {
    const record = await recordMisconceptionDetection({
      userId,
      conceptId,
      description: "Thinks a firewall assigns ports.",
      severity: "HIGH",
    });
    expect(record.occurrenceCount).toBe(1);
    expect(record.resolved).toBe(false);
  });

  it("re-detection reinforces the same unresolved misconception rather than duplicating it", async () => {
    const before = await prisma.studentMisconception.count({ where: { userId, conceptId, resolved: false } });
    const record = await recordMisconceptionDetection({
      userId,
      conceptId,
      description: "Thinks a firewall assigns ports (again).",
      severity: "MEDIUM",
    });
    const after = await prisma.studentMisconception.count({ where: { userId, conceptId, resolved: false } });
    expect(after).toBe(before);
    expect(record.occurrenceCount).toBe(2);
    // correctSinceCount resets on re-detection — any partial progress toward resolution is wiped out.
    expect(record.correctSinceCount).toBe(0);
  });

  it("a single correct answer does not resolve a misconception", async () => {
    const resolved = await recordIndependentCorrectEvidence(userId, conceptId);
    expect(resolved).toHaveLength(0);
    const current = await prisma.studentMisconception.findFirst({ where: { userId, conceptId, resolved: false } });
    expect(current?.resolved).toBe(false);
  });

  it(`resolves only after ${MISCONCEPTION_RESOLUTION_EVIDENCE_COUNT} pieces of independent correct evidence`, async () => {
    // One piece of evidence was already recorded in the previous test; apply enough more to cross both thresholds.
    let resolvedIds: string[] = [];
    for (let i = 0; i < MISCONCEPTION_RESOLUTION_EVIDENCE_COUNT + 1; i++) {
      resolvedIds = await recordIndependentCorrectEvidence(userId, conceptId);
      if (resolvedIds.length > 0) break;
    }
    expect(resolvedIds.length).toBeGreaterThan(0);
    const resolved = await prisma.studentMisconception.findUnique({ where: { id: resolvedIds[0] } });
    expect(resolved?.resolved).toBe(true);
    expect(resolved?.resolvedAt).not.toBeNull();
  });
});
