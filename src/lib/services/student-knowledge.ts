import { prisma } from "@/lib/db/prisma";
import type {
  EvidenceOutcome,
  MasteryStatus,
  MistakeSeverity,
  StudentConceptMastery,
  StudentMistakeCategory,
} from "@/generated/prisma/client";
import { calculateCalibration, type CalibrationResult } from "@/lib/learning/confidence-calibrator";

/**
 * Read side of the student knowledge model (spec §14). Every function here
 * is scoped to a userId the caller has already authenticated, and every
 * function checks ownership of the course/concept before returning
 * anything — never accept an arbitrary userId from the browser.
 *
 * "Unknown" is a first-class, valid answer throughout this module: a
 * concept the student has never attempted comes back with status UNKNOWN
 * and zeroed scores, not omitted and not silently treated as failure.
 */

export type MasteryBucket = "unknown" | "weak" | "developing" | "strong";

/** Collapses the 6-value MasteryStatus into the 4 buckets the UI displays (spec §20). */
export function bucketForStatus(status: MasteryStatus): MasteryBucket {
  switch (status) {
    case "UNKNOWN":
      return "unknown";
    case "LEARNING":
    case "NEEDS_REMEDIATION":
      return "weak";
    case "DEVELOPING":
      return "developing";
    case "STRONG":
    case "MASTERED":
      return "strong";
  }
}

/** Never say "you don't know X" — describe evidence, not certainty (spec §32). */
export function describeMasteryStatus(status: MasteryStatus): string {
  switch (status) {
    case "UNKNOWN":
      return "Not enough evidence yet.";
    case "LEARNING":
      return "Just getting started — early evidence only.";
    case "DEVELOPING":
      return "Your current evidence suggests this is still developing.";
    case "STRONG":
      return "Your current evidence suggests a strong understanding.";
    case "MASTERED":
      return "Consistently demonstrated across multiple successful attempts.";
    case "NEEDS_REMEDIATION":
      return "Your current evidence suggests this needs focused review.";
  }
}

export interface ConceptMasterySummary {
  conceptId: string;
  conceptName: string;
  status: MasteryStatus;
  overallMastery: number;
  recallScore: number;
  explanationScore: number;
  applicationScore: number;
  transferScore: number;
  confidenceScore: number;
  exposureCount: number;
  attemptCount: number;
  successCount: number;
  failureCount: number;
  hintCount: number;
  revealCount: number;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
}

function toSummary(
  concept: { id: string; name: string },
  mastery: StudentConceptMastery | null | undefined,
): ConceptMasterySummary {
  if (!mastery) {
    return {
      conceptId: concept.id,
      conceptName: concept.name,
      status: "UNKNOWN",
      overallMastery: 0,
      recallScore: 0,
      explanationScore: 0,
      applicationScore: 0,
      transferScore: 0,
      confidenceScore: 0,
      exposureCount: 0,
      attemptCount: 0,
      successCount: 0,
      failureCount: 0,
      hintCount: 0,
      revealCount: 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
    };
  }

  return {
    conceptId: concept.id,
    conceptName: concept.name,
    status: mastery.status,
    overallMastery: mastery.overallMastery,
    recallScore: mastery.recallScore,
    explanationScore: mastery.explanationScore,
    applicationScore: mastery.applicationScore,
    transferScore: mastery.transferScore,
    confidenceScore: mastery.confidenceScore,
    exposureCount: mastery.exposureCount,
    attemptCount: mastery.attemptCount,
    successCount: mastery.successCount,
    failureCount: mastery.failureCount,
    hintCount: mastery.hintCount,
    revealCount: mastery.revealCount,
    lastAttemptAt: mastery.lastAttemptAt,
    lastSuccessAt: mastery.lastSuccessAt,
    lastFailureAt: mastery.lastFailureAt,
  };
}

/** Returns null if the concept doesn't exist or isn't owned by `userId`. */
export async function getMastery(userId: string, conceptId: string): Promise<ConceptMasterySummary | null> {
  const concept = await prisma.concept.findFirst({
    where: { id: conceptId, course: { userId } },
    select: { id: true, name: true },
  });
  if (!concept) return null;

  const mastery = await prisma.studentConceptMastery.findUnique({
    where: { userId_conceptId: { userId, conceptId } },
  });

  return toSummary(concept, mastery);
}

/**
 * Loads every concept in a course plus this user's mastery rows for them in
 * two queries total, merging in memory — avoids N+1 (spec §30). Concepts
 * with no mastery row come back as UNKNOWN summaries, never omitted.
 */
async function loadCourseMasterySummaries(
  userId: string,
  courseId: string,
): Promise<{ concepts: Array<{ id: string; name: string }>; summaries: ConceptMasterySummary[] }> {
  const concepts = await prisma.concept.findMany({
    where: { courseId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const conceptIds = concepts.map((c) => c.id);
  const masteries =
    conceptIds.length > 0
      ? await prisma.studentConceptMastery.findMany({ where: { userId, conceptId: { in: conceptIds } } })
      : [];
  const masteryByConceptId = new Map(masteries.map((m) => [m.conceptId, m]));

  const summaries = concepts.map((c) => toSummary(c, masteryByConceptId.get(c.id)));
  return { concepts, summaries };
}

export interface CourseMastery {
  courseId: string;
  courseTitle: string;
  /** Average overallMastery across concepts with at least one exposure; excludes UNKNOWN so it never conflates "no evidence" with "weak" (spec §32). */
  overallMastery: number;
  concepts: ConceptMasterySummary[];
}

/** Returns null if the course doesn't exist or isn't owned by `userId`. */
export async function getCourseMastery(userId: string, courseId: string): Promise<CourseMastery | null> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId }, select: { id: true, title: true } });
  if (!course) return null;

  const { summaries } = await loadCourseMasterySummaries(userId, courseId);
  return { courseId: course.id, courseTitle: course.title, overallMastery: averageMastery(summaries), concepts: summaries };
}

function averageMastery(summaries: ConceptMasterySummary[]): number {
  const withEvidence = summaries.filter((s) => s.exposureCount > 0);
  if (withEvidence.length === 0) return 0;
  return withEvidence.reduce((sum, s) => sum + s.overallMastery, 0) / withEvidence.length;
}

async function getConceptsByBucket(
  userId: string,
  courseId: string,
  bucket: MasteryBucket,
): Promise<ConceptMasterySummary[] | null> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId } });
  if (!course) return null;

  const { summaries } = await loadCourseMasterySummaries(userId, courseId);
  return summaries.filter((s) => bucketForStatus(s.status) === bucket);
}

export const getWeakConcepts = (userId: string, courseId: string) => getConceptsByBucket(userId, courseId, "weak");
export const getDevelopingConcepts = (userId: string, courseId: string) =>
  getConceptsByBucket(userId, courseId, "developing");
export const getStrongConcepts = (userId: string, courseId: string) => getConceptsByBucket(userId, courseId, "strong");
export const getUnknownConcepts = (userId: string, courseId: string) => getConceptsByBucket(userId, courseId, "unknown");

export interface MistakeSummary {
  id: string;
  conceptId: string;
  conceptName: string;
  category: StudentMistakeCategory;
  description: string;
  severity: MistakeSeverity;
  resolved: boolean;
  resolvedAt: Date | null;
  createdAt: Date;
}

/** Returns null if the course doesn't exist or isn't owned by `userId`. Includes resolved mistakes unless `unresolvedOnly` is set — resolution history is never deleted (spec §24). */
export async function getRecentMistakes(
  userId: string,
  courseId: string,
  options: { limit?: number; unresolvedOnly?: boolean } = {},
): Promise<MistakeSummary[] | null> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId } });
  if (!course) return null;

  const limit = Math.min(100, Math.max(1, options.limit ?? 20));

  const mistakes = await prisma.studentMistake.findMany({
    where: { userId, concept: { courseId }, ...(options.unresolvedOnly ? { resolved: false } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { concept: { select: { id: true, name: true } } },
  });

  return mistakes.map((m) => ({
    id: m.id,
    conceptId: m.concept.id,
    conceptName: m.concept.name,
    category: m.category,
    description: m.description,
    severity: m.severity,
    resolved: m.resolved,
    resolvedAt: m.resolvedAt,
    createdAt: m.createdAt,
  }));
}

/**
 * Marks a mistake reviewed. Deliberately does NOT touch mastery (spec §23)
 * — mastery only moves on new evidence via recordLearningOutcome. The row
 * itself is never deleted, only flagged (spec §24).
 * Returns null if the mistake doesn't exist or isn't owned by `userId`.
 */
export async function resolveMistake(userId: string, mistakeId: string) {
  const mistake = await prisma.studentMistake.findFirst({ where: { id: mistakeId, userId } });
  if (!mistake) return null;

  return prisma.studentMistake.update({
    where: { id: mistakeId },
    data: { resolved: true, resolvedAt: new Date() },
  });
}

/** Returns null if the concept doesn't exist or isn't owned by `userId`. Mistake history for a single concept, most recent first. */
export async function getConceptMistakes(
  userId: string,
  conceptId: string,
  options: { limit?: number } = {},
): Promise<MistakeSummary[] | null> {
  const concept = await prisma.concept.findFirst({
    where: { id: conceptId, course: { userId } },
    select: { id: true, name: true },
  });
  if (!concept) return null;

  const limit = Math.min(100, Math.max(1, options.limit ?? 20));

  const mistakes = await prisma.studentMistake.findMany({
    where: { userId, conceptId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return mistakes.map((m) => ({
    id: m.id,
    conceptId: concept.id,
    conceptName: concept.name,
    category: m.category,
    description: m.description,
    severity: m.severity,
    resolved: m.resolved,
    resolvedAt: m.resolvedAt,
    createdAt: m.createdAt,
  }));
}

export interface EvidenceSummary {
  id: string;
  conceptId: string;
  outcome: EvidenceOutcome;
  score: number;
  confidence: number | null;
  notes: string | null;
  createdAt: Date;
}

/**
 * Full evidence history for a concept, most recent first — the backing
 * data for a future "mastery over time" chart (spec §22; reverse the array
 * for chronological order).
 * Returns null if the concept doesn't exist or isn't owned by `userId`.
 */
export async function getConceptEvidence(
  userId: string,
  conceptId: string,
  options: { limit?: number } = {},
): Promise<EvidenceSummary[] | null> {
  const concept = await prisma.concept.findFirst({ where: { id: conceptId, course: { userId } }, select: { id: true } });
  if (!concept) return null;

  const limit = Math.min(200, Math.max(1, options.limit ?? 50));

  const evidence = await prisma.knowledgeEvidence.findMany({
    where: { userId, conceptId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return evidence.map((e) => ({
    id: e.id,
    conceptId: e.conceptId,
    outcome: e.outcome,
    score: e.score,
    confidence: e.confidence,
    notes: e.notes,
    createdAt: e.createdAt,
  }));
}

export interface PrerequisiteStatusNode {
  concept: { id: string; name: string };
  mastery: ConceptMasterySummary;
  prerequisites: PrerequisiteStatusNode[];
}

const DEFAULT_MAX_PREREQUISITE_DEPTH = 6;

function buildPrerequisiteNode(
  conceptId: string,
  conceptsById: Map<string, { id: string; name: string }>,
  masteryByConceptId: Map<string, StudentConceptMastery>,
  prerequisitesByTarget: Map<string, string[]>,
  pathVisited: Set<string>,
  depth: number,
  maxDepth: number,
): PrerequisiteStatusNode {
  const concept = conceptsById.get(conceptId)!;
  const mastery = toSummary(concept, masteryByConceptId.get(conceptId));

  const prerequisites: PrerequisiteStatusNode[] = [];
  if (depth < maxDepth) {
    for (const prereqId of prerequisitesByTarget.get(conceptId) ?? []) {
      // Guard against cycles on this path (diamond-shaped DAGs still fine —
      // the same ancestor may legitimately appear via two different paths).
      if (pathVisited.has(prereqId)) continue;
      prerequisites.push(
        buildPrerequisiteNode(
          prereqId,
          conceptsById,
          masteryByConceptId,
          prerequisitesByTarget,
          new Set(pathVisited).add(prereqId),
          depth + 1,
          maxDepth,
        ),
      );
    }
  }

  return { concept, mastery, prerequisites };
}

/**
 * Recursively inspects a concept's prerequisite chain and this student's
 * mastery of each link in it — e.g. TCP strong, Ports weak, Firewalls weak
 * -> Ports surfaces as a remediation candidate because it's both weak and a
 * prerequisite of another weak concept. This is query capability only
 * (spec §16) — no decision-making about what to study next lives here.
 *
 * Loads the whole course's concepts/prerequisite edges/mastery rows once
 * and recurses in memory rather than querying per node (spec §30).
 * Returns null if the concept doesn't exist or isn't owned by `userId`.
 */
export async function getPrerequisiteStatus(
  userId: string,
  conceptId: string,
  maxDepth = DEFAULT_MAX_PREREQUISITE_DEPTH,
): Promise<PrerequisiteStatusNode | null> {
  const root = await prisma.concept.findFirst({
    where: { id: conceptId, course: { userId } },
    select: { id: true, name: true, courseId: true },
  });
  if (!root) return null;

  const [concepts, prerequisiteEdges] = await Promise.all([
    prisma.concept.findMany({ where: { courseId: root.courseId }, select: { id: true, name: true } }),
    prisma.conceptRelationship.findMany({
      where: { relationshipType: "prerequisite", sourceConcept: { courseId: root.courseId } },
      select: { sourceConceptId: true, targetConceptId: true },
    }),
  ]);

  const conceptIds = concepts.map((c) => c.id);
  const masteries =
    conceptIds.length > 0
      ? await prisma.studentConceptMastery.findMany({ where: { userId, conceptId: { in: conceptIds } } })
      : [];

  const conceptsById = new Map(concepts.map((c) => [c.id, c]));
  const masteryByConceptId = new Map(masteries.map((m) => [m.conceptId, m]));
  const prerequisitesByTarget = new Map<string, string[]>();
  for (const edge of prerequisiteEdges) {
    const list = prerequisitesByTarget.get(edge.targetConceptId) ?? [];
    list.push(edge.sourceConceptId);
    prerequisitesByTarget.set(edge.targetConceptId, list);
  }

  return buildPrerequisiteNode(
    root.id,
    conceptsById,
    masteryByConceptId,
    prerequisitesByTarget,
    new Set([root.id]),
    0,
    maxDepth,
  );
}

export interface PrerequisiteGap {
  concept: ConceptMasterySummary;
  prerequisite: ConceptMasterySummary;
}

/** Direct (one-hop) prerequisite edges where both the dependent and its prerequisite are weak — the clearest remediation signal. */
async function computePrerequisiteGaps(
  courseId: string,
  summariesByConceptId: Map<string, ConceptMasterySummary>,
): Promise<PrerequisiteGap[]> {
  const edges = await prisma.conceptRelationship.findMany({
    where: { relationshipType: "prerequisite", sourceConcept: { courseId } },
    select: { sourceConceptId: true, targetConceptId: true },
  });

  const gaps: PrerequisiteGap[] = [];
  for (const edge of edges) {
    const dependent = summariesByConceptId.get(edge.targetConceptId);
    const prerequisite = summariesByConceptId.get(edge.sourceConceptId);
    if (!dependent || !prerequisite) continue;
    if (bucketForStatus(dependent.status) !== "weak") continue;
    if (bucketForStatus(prerequisite.status) !== "weak") continue;
    gaps.push({ concept: dependent, prerequisite });
  }
  return gaps;
}

async function getRecentFailures(userId: string, courseId: string, limit = 10): Promise<EvidenceSummary[]> {
  const failures = await prisma.knowledgeEvidence.findMany({
    where: { userId, outcome: "FAILURE", concept: { courseId } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return failures.map((e) => ({
    id: e.id,
    conceptId: e.conceptId,
    outcome: e.outcome,
    score: e.score,
    confidence: e.confidence,
    notes: e.notes,
    createdAt: e.createdAt,
  }));
}

async function getCourseCalibration(userId: string, courseId: string): Promise<CalibrationResult> {
  const rows = await prisma.knowledgeEvidence.findMany({
    where: { userId, concept: { courseId }, confidence: { not: null } },
    select: { confidence: true, score: true },
  });
  return calculateCalibration(rows.map((r) => ({ confidence: r.confidence, correctness: r.score })));
}

export interface KnowledgeSnapshot {
  courseId: string;
  courseTitle: string;
  overallMastery: number;
  strongConcepts: ConceptMasterySummary[];
  weakConcepts: ConceptMasterySummary[];
  unknownConcepts: ConceptMasterySummary[];
  misconceptions: MistakeSummary[];
  prerequisiteGaps: PrerequisiteGap[];
  recentFailures: EvidenceSummary[];
  calibration: CalibrationResult;
}

/**
 * The single aggregate view of a student's course knowledge — designed as
 * the input a future adaptive engine (Phase 6) will consume (spec §17), not
 * as a UI-specific payload. Not a decision engine itself: it surfaces
 * signals (weak concepts, prerequisite gaps, unresolved misconceptions,
 * calibration) without deciding what to do about them.
 * Returns null if the course doesn't exist or isn't owned by `userId`.
 */
export async function getKnowledgeSnapshot(userId: string, courseId: string): Promise<KnowledgeSnapshot | null> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId }, select: { id: true, title: true } });
  if (!course) return null;

  const { summaries } = await loadCourseMasterySummaries(userId, courseId);
  const summariesByConceptId = new Map(summaries.map((s) => [s.conceptId, s]));

  const [misconceptionRows, prerequisiteGaps, recentFailures, calibration] = await Promise.all([
    prisma.studentMistake.findMany({
      where: { userId, resolved: false, category: "MISCONCEPTION", concept: { courseId } },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { concept: { select: { id: true, name: true } } },
    }),
    computePrerequisiteGaps(courseId, summariesByConceptId),
    getRecentFailures(userId, courseId),
    getCourseCalibration(userId, courseId),
  ]);

  const misconceptions: MistakeSummary[] = misconceptionRows.map((m) => ({
    id: m.id,
    conceptId: m.concept.id,
    conceptName: m.concept.name,
    category: m.category,
    description: m.description,
    severity: m.severity,
    resolved: m.resolved,
    resolvedAt: m.resolvedAt,
    createdAt: m.createdAt,
  }));

  return {
    courseId: course.id,
    courseTitle: course.title,
    overallMastery: averageMastery(summaries),
    strongConcepts: summaries.filter((s) => bucketForStatus(s.status) === "strong"),
    weakConcepts: summaries.filter((s) => bucketForStatus(s.status) === "weak"),
    unknownConcepts: summaries.filter((s) => bucketForStatus(s.status) === "unknown"),
    misconceptions,
    prerequisiteGaps,
    recentFailures,
    calibration,
  };
}
