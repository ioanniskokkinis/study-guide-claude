import { prisma } from "@/lib/db/prisma";
import type { AdaptationTrigger, Prisma, StudyRoadmapItemAction } from "@/generated/prisma/client";
import { resolveStudyScope, InvalidScopeError, type ScopeInput } from "./scope";
import { analyzeKnowledgeGaps, NoScopedConceptsError, type ConceptPriority } from "./knowledge-gaps";
import { calculateTimeBudget, type TimeBudget } from "./time-budget";
import { buildAdvisorContext } from "./context";
import { generateRoadmapWithAi } from "./roadmap-generator";
import { buildItemReason } from "./reasons";
import { computeRoadmapDiff, type DiffableItem, type RoadmapChangeSummary } from "./diff";
import { applyExamModeBias, examModePhase } from "./exam-mode";
import { getConceptPerformanceTrends } from "./trends";
import { MASTERY_THRESHOLDS } from "@/lib/learning/mastery-engine";

export { InvalidScopeError, NoScopedConceptsError };

/** No AI call is ever the reason a roadmap can't be created — this wraps a real provider/schema failure so callers can show a clean retry affordance instead of a corrupt half-written roadmap (spec §49). */
export class RoadmapGenerationError extends Error {
  constructor(cause: unknown) {
    super("The Study Advisor could not generate a roadmap right now. Please try again.");
    this.cause = cause;
  }
}

/** A course/scope with no deadline gets a fixed default planning horizon (spec §22/§48 — "no deadline" is a supported, graceful case, not a blocker). */
const DEFAULT_PLANNING_HORIZON_DAYS = 28;
const FALLBACK_FOCUS_SIZE = 3;

export interface CreateRoadmapInput {
  courseId: string;
  goal: string;
  targetScore?: number | null;
  deadline?: Date | null;
  minutesPerDay: number;
  studyDays?: number[];
  scope: ScopeInput;
  /** Set only by replanStudyRoadmap() (Phase 15 §36-37) — links the new version to the one it supersedes and archives the old one, all inside the same transaction. */
  replacesRoadmapId?: string;
  /** Set only by replanStudyRoadmap() — surfaced to the AI so its summary/reasons can honestly account for prior progress instead of pretending this is a fresh start. */
  replanContext?: { overdueCount: number; completedCount: number; missedMinutes?: number };
  /** Why this version exists (Phase 16 §3) — defaults to INITIAL_GENERATION; replanStudyRoadmap() always passes an explicit value. */
  adaptationTrigger?: AdaptationTrigger;
  /** Short human-readable explanation shown to the student (Phase 16 §44) — null for the initial version. */
  adaptationReason?: string | null;
}

export class InvalidRoadmapInputError extends Error {}

function validateInput(input: CreateRoadmapInput): void {
  if (!input.goal || input.goal.trim().length === 0) {
    throw new InvalidRoadmapInputError("A goal is required.");
  }
  if (!Number.isFinite(input.minutesPerDay) || input.minutesPerDay <= 0 || input.minutesPerDay > 24 * 60) {
    throw new InvalidRoadmapInputError("minutesPerDay must be a positive number of minutes, at most 1440.");
  }
  if (input.deadline && input.deadline.getTime() <= Date.now()) {
    throw new InvalidRoadmapInputError("deadline must be in the future.");
  }
  if (input.targetScore != null && (input.targetScore < 0 || input.targetScore > 1)) {
    throw new InvalidRoadmapInputError("targetScore must be between 0 and 1.");
  }
  if (input.studyDays && input.studyDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new InvalidRoadmapInputError("studyDays must be weekday indices between 0 and 6.");
  }
}

/** Exported so Phase 16's next-best-action engine (src/lib/advisor/next-action.ts) reuses the exact same mastery-bucket -> action mapping instead of a second, possibly-diverging one. */
export function actionForPriority(priority: ConceptPriority): StudyRoadmapItemAction {
  const hasAttempts = priority.recentAccuracy != null || priority.masteryPercent > 0;
  if (!hasAttempts) return "LEARN";
  if (priority.masteryPercent < MASTERY_THRESHOLDS.weak) return "ACTIVE_RECALL";
  if (priority.masteryPercent < MASTERY_THRESHOLDS.strong) return "PRACTICE";
  return "REVIEW";
}

async function findPrimarySourceDocuments(conceptIds: string[]): Promise<Map<string, string>> {
  if (conceptIds.length === 0) return new Map();
  const sources = await prisma.conceptSource.findMany({
    where: { conceptId: { in: conceptIds } },
    orderBy: { relevance: "desc" },
    select: { conceptId: true, documentChunk: { select: { documentId: true } } },
  });
  const map = new Map<string, string>();
  for (const source of sources) {
    if (!map.has(source.conceptId)) map.set(source.conceptId, source.documentChunk.documentId);
  }
  return map;
}

function daysUntil(date: Date | null, now: Date): number | null {
  if (!date) return null;
  return Math.max(0, Math.round((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
}

interface BuildContentParams {
  courseTitle: string;
  input: CreateRoadmapInput;
  now: Date;
  endDate: Date;
  timeBudget: TimeBudget;
  priorityById: Map<string, ConceptPriority>;
  sourceDocumentByConceptId: Map<string, string>;
  aiWeeks: Array<{ weekNumber: number; focusConceptIds: string[]; reason: string }>;
  aiMilestones: Array<{ title: string; afterWeek: number }>;
}

/** Deterministically distributes each AI-chosen week's focus concepts across that week's actual study days, one concept per day (round-robin), never exceeding minutesPerDay (spec §29, §33). */
function buildWeeksAndItems(params: BuildContentParams) {
  const weeks: Array<{
    weekNumber: number;
    startDate: Date;
    endDate: Date;
    focusSummary: string;
    reason: string;
    estimatedMinutes: number;
    items: Array<{
      conceptId: string | null;
      action: StudyRoadmapItemAction;
      title: string;
      estimatedMinutes: number;
      priority: number;
      reason: string;
      scheduledDate: Date | null;
      isMilestone: boolean;
      baselineMastery: number | null;
      sourceDocumentId: string | null;
    }>;
  }> = [];

  const topPriorities = Array.from(params.priorityById.values());
  const now = params.now;
  const phase = examModePhase(params.endDate, now);

  for (const weekBudget of params.timeBudget.weeks) {
    const aiWeek = params.aiWeeks.find((w) => w.weekNumber === weekBudget.weekNumber);
    const focusConceptIds =
      aiWeek && aiWeek.focusConceptIds.length > 0
        ? aiWeek.focusConceptIds
        : topPriorities.slice(0, FALLBACK_FOCUS_SIZE).map((p) => p.conceptId);

    const focusNames = focusConceptIds.map((id) => params.priorityById.get(id)?.conceptName).filter((n): n is string => !!n);

    const items: (typeof weeks)[number]["items"] = [];
    if (focusConceptIds.length > 0) {
      weekBudget.studyDates.forEach((date, i) => {
        const conceptId = focusConceptIds[i % focusConceptIds.length];
        const priority = params.priorityById.get(conceptId);
        if (!priority) return;

        const baseAction = actionForPriority(priority);
        items.push({
          conceptId,
          action: applyExamModeBias(baseAction, phase, priority.masteryPercent < MASTERY_THRESHOLDS.weak),
          title: priority.conceptName,
          estimatedMinutes: params.input.minutesPerDay,
          priority: priority.breakdown.value,
          reason: buildItemReason(priority, daysUntil(params.endDate, now)),
          scheduledDate: date,
          isMilestone: false,
          baselineMastery: priority.masteryPercent,
          sourceDocumentId: params.sourceDocumentByConceptId.get(conceptId) ?? null,
        });
      });
    }

    weeks.push({
      weekNumber: weekBudget.weekNumber,
      startDate: weekBudget.startDate,
      endDate: weekBudget.endDate,
      focusSummary: focusNames.length > 0 ? focusNames.join(", ") : "Continued practice",
      reason: aiWeek?.reason ?? "Building on the concepts already covered in earlier weeks.",
      estimatedMinutes: weekBudget.availableMinutes,
      items,
    });
  }

  const milestoneItems = params.aiMilestones
    .map((milestone) => {
      const week = params.timeBudget.weeks.find((w) => w.weekNumber === milestone.afterWeek);
      if (!week) return null;
      return {
        weekNumber: milestone.afterWeek,
        item: {
          conceptId: null,
          action: "REVIEW" as StudyRoadmapItemAction,
          title: milestone.title,
          estimatedMinutes: 0,
          priority: 0,
          reason: "Milestone",
          scheduledDate: week.endDate,
          isMilestone: true,
          baselineMastery: null,
          sourceDocumentId: null,
        },
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  for (const { weekNumber, item } of milestoneItems) {
    const week = weeks.find((w) => w.weekNumber === weekNumber);
    week?.items.push(item);
  }

  return weeks;
}

/**
 * Full roadmap-generation pipeline (Phase 15 §21-34): resolve scope ->
 * deterministic knowledge-gap analysis (reusing the Phase 6 adaptive
 * engine) -> deterministic time budget -> compact AI context -> one AI call
 * -> deterministic weekly/daily scheduling -> persist. Everything except
 * the single AI call is plain TypeScript arithmetic; the whole result is
 * written in one transaction so a mid-generation failure never leaves a
 * partial roadmap behind (spec §49).
 */
export async function createStudyRoadmap(userId: string, input: CreateRoadmapInput) {
  validateInput(input);

  const course = await prisma.course.findFirst({ where: { id: input.courseId, userId }, select: { id: true, title: true } });
  if (!course) throw new InvalidScopeError("Course not found.");

  // Loaded up front (before any AI call) so a replan's completed work can be carried forward and
  // diffed against the new plan even if the AI call itself later fails (spec §26-27).
  const previousItems = input.replacesRoadmapId
    ? await prisma.studyRoadmapItem.findMany({ where: { roadmapId: input.replacesRoadmapId } })
    : [];
  // Phase 16 §3/§26 — each replan is one version higher than the roadmap it replaces, so version
  // numbers stay consistent across a whole replan chain instead of every row defaulting to 1.
  const previousVersion = input.replacesRoadmapId
    ? (await prisma.studyRoadmap.findUnique({ where: { id: input.replacesRoadmapId }, select: { version: true } }))?.version
    : undefined;

  const scope = await resolveStudyScope(userId, input.courseId, input.scope);
  const gaps = await analyzeKnowledgeGaps(userId, input.courseId, scope.conceptIds);

  const now = new Date();
  const endDate = input.deadline ?? new Date(now.getTime() + DEFAULT_PLANNING_HORIZON_DAYS * 24 * 60 * 60 * 1000);
  const studyDays = input.studyDays ?? [];
  const timeBudget = calculateTimeBudget({ minutesPerDay: input.minutesPerDay, studyDays, startDate: now, endDate });

  const allowedConceptIds = new Set(gaps.priorities.map((p) => p.conceptId));
  const trends = await getConceptPerformanceTrends(userId, Array.from(allowedConceptIds));

  const context = buildAdvisorContext({
    courseTitle: course.title,
    goal: input.goal,
    targetScore: input.targetScore ?? null,
    deadline: input.deadline ?? null,
    scopeLabel: scope.label,
    minutesPerDay: input.minutesPerDay,
    timeBudget,
    gaps,
    replanContext: input.replanContext,
    trends,
  });

  let aiOutput;
  try {
    aiOutput = await generateRoadmapWithAi({
      input: context,
      allowedConceptIds,
      userId,
      courseId: input.courseId,
      requestType: input.replacesRoadmapId ? "STUDY_ADVISOR_REPLAN" : "STUDY_ADVISOR_INITIAL",
    });
  } catch (error) {
    throw new RoadmapGenerationError(error);
  }

  const priorityById = new Map(gaps.priorities.map((p) => [p.conceptId, p]));
  const sourceDocumentByConceptId = await findPrimarySourceDocuments(Array.from(allowedConceptIds));

  const weeks = buildWeeksAndItems({
    courseTitle: course.title,
    input,
    now,
    endDate,
    timeBudget,
    priorityById,
    sourceDocumentByConceptId,
    aiWeeks: aiOutput.weeks,
    aiMilestones: aiOutput.milestones,
  });

  // Completed work is preserved by copying it forward as already-COMPLETED items on the new
  // roadmap (spec §26) — never regenerated, never left only in the archived old version.
  const completedToCarryForward = previousItems.filter((item) => !item.isMilestone && item.status === "COMPLETED");

  let changeSummary: RoadmapChangeSummary | null = null;
  if (input.replacesRoadmapId) {
    const oldDiffable: DiffableItem[] = previousItems.map((item) => ({
      conceptId: item.conceptId,
      title: item.title,
      estimatedMinutes: item.estimatedMinutes,
      scheduledDate: item.scheduledDate,
      action: item.action,
      isMilestone: item.isMilestone,
      status: item.status,
    }));
    const newDiffable: DiffableItem[] = weeks.flatMap((w) => w.items);
    changeSummary = computeRoadmapDiff(oldDiffable, newDiffable);
  }

  return prisma.$transaction(async (tx) => {
    const roadmap = await tx.studyRoadmap.create({
      data: {
        userId,
        courseId: input.courseId,
        title: input.goal.slice(0, 200),
        goal: input.goal,
        targetScore: input.targetScore ?? null,
        deadline: input.deadline ?? null,
        minutesPerDay: input.minutesPerDay,
        studyDays,
        scopeType: scope.scopeType,
        scopeFolderId: scope.scopeFolderId,
        summary: aiOutput.summary,
        risks: aiOutput.risks as unknown as Prisma.InputJsonValue,
        recommendations: aiOutput.recommendations as unknown as Prisma.InputJsonValue,
        startDate: now,
        endDate,
        version: previousVersion != null ? previousVersion + 1 : 1,
        replacesRoadmapId: input.replacesRoadmapId,
        adaptationTrigger: input.adaptationTrigger ?? "INITIAL_GENERATION",
        adaptationReason: input.adaptationReason ?? null,
        changeSummary: changeSummary ? (changeSummary as unknown as Prisma.InputJsonValue) : undefined,
        lastEvaluatedAt: now,
      },
    });

    if (input.replacesRoadmapId) {
      await tx.studyRoadmap.update({ where: { id: input.replacesRoadmapId }, data: { status: "ARCHIVED" } });
    }

    if (scope.scopeType === "DOCUMENTS" && scope.documentIds.length > 0) {
      await tx.studyRoadmapDocument.createMany({
        data: scope.documentIds.map((documentId) => ({ roadmapId: roadmap.id, documentId })),
      });
    }

    for (const week of weeks) {
      const weekRow = await tx.studyRoadmapWeek.create({
        data: {
          roadmapId: roadmap.id,
          weekNumber: week.weekNumber,
          startDate: week.startDate,
          endDate: week.endDate,
          focusSummary: week.focusSummary,
          reason: week.reason,
          estimatedMinutes: week.estimatedMinutes,
        },
      });

      if (week.items.length > 0) {
        await tx.studyRoadmapItem.createMany({
          data: week.items.map((item) => ({
            roadmapId: roadmap.id,
            weekId: weekRow.id,
            ...item,
          })),
        });
      }
    }

    if (completedToCarryForward.length > 0) {
      await tx.studyRoadmapItem.createMany({
        data: completedToCarryForward.map((item) => ({
          roadmapId: roadmap.id,
          weekId: null,
          conceptId: item.conceptId,
          action: item.action,
          title: item.title,
          estimatedMinutes: item.estimatedMinutes,
          priority: item.priority,
          reason: item.reason,
          scheduledDate: item.scheduledDate,
          status: "COMPLETED" as const,
          completedAt: item.completedAt,
          baselineMastery: item.baselineMastery,
          sourceDocumentId: item.sourceDocumentId,
          carriedForward: true,
        })),
      });
    }

    return tx.studyRoadmap.findUniqueOrThrow({
      where: { id: roadmap.id },
      include: { weeks: { include: { items: true }, orderBy: { weekNumber: "asc" } }, scopeDocuments: true },
    });
  });
}
