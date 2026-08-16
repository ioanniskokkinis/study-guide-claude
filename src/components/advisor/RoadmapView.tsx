"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { getRoadmap, getTodayPlan } from "@/lib/advisor/queries";
import type { RoadmapProgress } from "@/lib/advisor/progress";
import type { HealthResult, RoadmapHealth } from "@/lib/advisor/health";
import type { AdaptationCheckResult } from "@/lib/advisor/change-detection";
import type { NextBestActionResult } from "@/lib/advisor/next-action";
import type { RoadmapChangeSummary } from "@/lib/advisor/diff";

type Roadmap = NonNullable<Awaited<ReturnType<typeof getRoadmap>>>;
type TodayPlan = NonNullable<Awaited<ReturnType<typeof getTodayPlan>>>;

const HEALTH_COPY: Record<RoadmapHealth, { label: string; className: string }> = {
  ON_TRACK: { label: "Your plan is on track.", className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  AT_RISK: { label: "You're slightly behind schedule.", className: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  BEHIND: { label: "You're behind schedule. We've adjusted the next few sessions.", className: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300" },
  INSUFFICIENT_DATA: { label: "Not enough data yet to tell if you're on track.", className: "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400" },
};

const NEXT_ACTION_LABEL: Record<string, string> = {
  REVIEW_TOPIC: "Review",
  PRACTICE_TOPIC: "Practice",
  LEARN_PREREQUISITE: "Learn",
  ACTIVE_RECALL: "Active recall",
  TUTOR: "Talk to the Tutor",
  EXAM_PRACTICE: "Exam practice",
  SPACED_REPETITION: "Review",
};

function formatDate(date: Date | string) {
  return new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

const ACTION_LABEL: Record<string, string> = {
  LEARN: "Learn",
  REVIEW: "Review",
  PRACTICE: "Practice",
  ACTIVE_RECALL: "Active recall",
  SPACED_REPETITION: "Spaced repetition",
  TUTOR: "Tutor",
  EXAM_PRACTICE: "Exam practice",
};

/**
 * Roadmap detail view (Phase 15 §34) — goal, deadline, progress, current
 * knowledge, priority topics, weekly roadmap, today's plan, milestones, and
 * study material scope, in one page without turning into a sprawling
 * dashboard. Replan creates a new version and navigates to it; nothing here
 * ever calls the AI directly — Replan is the only mutating action that
 * does, and it's a single explicit button press.
 */
export function RoadmapView({
  courseId,
  roadmap,
  progress,
  todayPlan,
  health,
  adaptation,
}: {
  courseId: string;
  roadmap: Roadmap;
  progress: RoadmapProgress;
  todayPlan: TodayPlan;
  health: HealthResult;
  adaptation: AdaptationCheckResult | null;
}) {
  const router = useRouter();
  const [replanning, setReplanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [nextAction, setNextAction] = useState<NextBestActionResult | null>(null);
  const [loadingNextAction, setLoadingNextAction] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [resumeNote, setResumeNote] = useState<string | null>(null);

  const changeSummary = roadmap.changeSummary as RoadmapChangeSummary | null;

  const priorityItems = roadmap.weeks
    .flatMap((w) => w.items)
    .filter((i) => !i.isMilestone && i.conceptId)
    .sort((a, b) => b.priority - a.priority)
    .filter((item, index, all) => all.findIndex((i) => i.conceptId === item.conceptId) === index)
    .slice(0, 8);

  const milestones = roadmap.weeks.flatMap((w) => w.items.filter((i) => i.isMilestone));

  const scopeLabel =
    roadmap.scopeType === "COURSE"
      ? "Entire course"
      : roadmap.scopeType === "FOLDER"
        ? (roadmap.scopeFolder?.name ?? "Folder")
        : roadmap.scopeDocuments.map((d) => d.document.originalFilename).join(", ");

  async function markItem(itemId: string, status: "COMPLETED" | "PENDING") {
    setPendingItemId(itemId);
    await fetch(`/api/roadmap-items/${itemId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setPendingItemId(null);
    router.refresh();
  }

  async function handleReplan() {
    setReplanning(true);
    setError(null);
    try {
      const response = await fetch(`/api/roadmaps/${roadmap.id}/replan`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not replan.");
      router.push(`/courses/${courseId}/advisor/${body.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not replan.");
    } finally {
      setReplanning(false);
    }
  }

  async function handleWhatsNext() {
    setLoadingNextAction(true);
    try {
      const response = await fetch(`/api/roadmaps/${roadmap.id}/next-action`);
      const body = await response.json().catch(() => null);
      setNextAction(response.ok ? body : { type: "NONE", reason: "Could not load a suggestion right now." });
    } catch {
      setNextAction({ type: "NONE", reason: "Could not load a suggestion right now." });
    } finally {
      setLoadingNextAction(false);
    }
  }

  async function handlePause() {
    setPausing(true);
    try {
      await fetch(`/api/roadmaps/${roadmap.id}/pause`, { method: "POST" });
      router.refresh();
    } finally {
      setPausing(false);
    }
  }

  async function handleResume() {
    setPausing(true);
    setResumeNote(null);
    try {
      const response = await fetch(`/api/roadmaps/${roadmap.id}/resume`, { method: "POST" });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.suggestedAdaptation?.needed) {
        setResumeNote("Your plan may need a few adjustments now that you're back. You can review changes below with Replan.");
      }
      router.refresh();
    } finally {
      setPausing(false);
    }
  }

  return (
    <div className="mt-2">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{roadmap.title}</h1>
          <p className="mt-1 text-sm text-zinc-500">{roadmap.goal}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {roadmap.status === "ACTIVE" && (
            <>
              <button
                type="button"
                onClick={handlePause}
                disabled={pausing}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
              >
                Pause
              </button>
              <button
                type="button"
                onClick={handleReplan}
                disabled={replanning}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
              >
                {replanning ? "Replanning…" : "Replan"}
              </button>
            </>
          )}
          {roadmap.status === "PAUSED" && (
            <button
              type="button"
              onClick={handleResume}
              disabled={pausing}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
            >
              {pausing ? "Resuming…" : "Resume"}
            </button>
          )}
          <a
            href={`/api/roadmaps/${roadmap.id}/pdf`}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Export PDF
          </a>
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {resumeNote && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{resumeNote}</p>}

      <span className={`mt-4 inline-block rounded-full px-3 py-1 text-xs font-medium ${HEALTH_COPY[health.health].className}`}>
        {HEALTH_COPY[health.health].label}
      </span>

      {adaptation?.needed && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium text-amber-900 dark:text-amber-200">Your study plan may need an update.</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-amber-800 dark:text-amber-300">
            {adaptation.details.map((detail, i) => (
              <li key={i}>{detail}</li>
            ))}
          </ul>
          {roadmap.status === "ACTIVE" && (
            <button
              type="button"
              onClick={handleReplan}
              disabled={replanning}
              className="mt-3 rounded-md bg-amber-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:opacity-50 dark:bg-amber-200 dark:text-amber-950"
            >
              {replanning ? "Updating…" : "Review and update my plan"}
            </button>
          )}
        </div>
      )}

      {changeSummary && (changeSummary.removed.length > 0 || changeSummary.movedEarlier.length > 0 || changeSummary.added.length > 0) && (
        <div className="mt-4 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <p className="font-medium text-zinc-900 dark:text-zinc-50">What changed in this plan</p>
          {roadmap.adaptationReason && <p className="mt-1 text-zinc-500">{roadmap.adaptationReason}</p>}
          {changeSummary.added.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-zinc-400">Added</p>
              <ul className="list-disc space-y-0.5 pl-5 text-zinc-700 dark:text-zinc-300">
                {changeSummary.added.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {changeSummary.movedEarlier.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-zinc-400">Moved earlier</p>
              <ul className="list-disc space-y-0.5 pl-5 text-zinc-700 dark:text-zinc-300">
                {changeSummary.movedEarlier.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {changeSummary.removed.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-zinc-400">No longer needed</p>
              <ul className="list-disc space-y-0.5 pl-5 text-zinc-700 dark:text-zinc-300">
                {changeSummary.removed.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-zinc-200 p-4 text-sm sm:grid-cols-4 dark:border-zinc-800">
        <div>
          <dt className="text-xs text-zinc-400">Deadline</dt>
          <dd className="mt-0.5 font-medium text-zinc-900 dark:text-zinc-50">{roadmap.deadline ? formatDate(roadmap.deadline) : "None set"}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-400">Study material</dt>
          <dd className="mt-0.5 truncate font-medium text-zinc-900 dark:text-zinc-50">{scopeLabel}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-400">Progress</dt>
          <dd className="mt-0.5 font-medium text-zinc-900 dark:text-zinc-50">{pct(progress.overallProgressPercent)}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-400">Current knowledge</dt>
          <dd className="mt-0.5 font-medium text-zinc-900 dark:text-zinc-50">{pct(progress.currentAverageMasteryPercent)} mastery</dd>
        </div>
      </dl>

      <div className="mt-2">
        <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
          <div className="h-full bg-zinc-900 dark:bg-zinc-50" style={{ width: pct(progress.overallProgressPercent) }} />
        </div>
        <p className="mt-1 text-xs text-zinc-400">
          {progress.completedItems}/{progress.totalItems} items complete
          {progress.overdueItems > 0 ? ` · ${progress.overdueItems} overdue` : ""}
        </p>
      </div>

      {roadmap.summary && <p className="mt-6 text-sm text-zinc-700 dark:text-zinc-300">{roadmap.summary}</p>}

      <h2 className="mt-8 text-sm font-medium text-zinc-500">Today&rsquo;s plan</h2>
      {todayPlan.today.length === 0 && todayPlan.overdue.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">Nothing scheduled today. Enjoy the rest.</p>
      ) : (
        <ul className="mt-2 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {[...todayPlan.overdue, ...todayPlan.today].map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <input
                type="checkbox"
                checked={item.status === "COMPLETED"}
                disabled={pendingItemId === item.id}
                onChange={() => markItem(item.id, item.status === "COMPLETED" ? "PENDING" : "COMPLETED")}
                aria-label={`Mark "${item.title}" complete`}
              />
              <div className="min-w-0 flex-1">
                <p className={item.status === "COMPLETED" ? "truncate font-medium text-zinc-400 line-through" : "truncate font-medium text-zinc-900 dark:text-zinc-50"}>
                  {ACTION_LABEL[item.action] ?? item.action}: {item.title}
                </p>
                <p className="truncate text-xs text-zinc-400">
                  {item.estimatedMinutes} min
                  {item.scheduledDate && new Date(item.scheduledDate) < new Date(new Date().setHours(0, 0, 0, 0)) ? " · overdue" : ""}
                  {item.reason ? ` — ${item.reason}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">Not sure where to start?</p>
          <button
            type="button"
            onClick={handleWhatsNext}
            disabled={loadingNextAction}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {loadingNextAction ? "Thinking…" : "What should I study now?"}
          </button>
        </div>
        {nextAction && (
          <div className="mt-3 text-sm">
            {nextAction.type === "NONE" ? (
              <p className="text-zinc-500">{nextAction.reason}</p>
            ) : (
              <>
                <p className="font-medium text-zinc-900 dark:text-zinc-50">
                  {NEXT_ACTION_LABEL[nextAction.type] ?? nextAction.type}: {nextAction.conceptName}
                </p>
                <p className="mt-0.5 text-xs text-zinc-400">
                  {nextAction.durationMinutes} min — {nextAction.reason}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      <h2 className="mt-8 text-sm font-medium text-zinc-500">Priority topics</h2>
      <ul className="mt-2 space-y-2">
        {priorityItems.map((item) => (
          <li key={item.id} className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <p className="font-medium text-zinc-900 dark:text-zinc-50">{item.title}</p>
            <p className="mt-0.5 text-xs text-zinc-400">{item.reason}</p>
          </li>
        ))}
      </ul>

      <h2 className="mt-8 text-sm font-medium text-zinc-500">Weekly roadmap</h2>
      <ul className="mt-2 space-y-3">
        {roadmap.weeks.map((week) => (
          <li key={week.id} className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <div className="flex items-center justify-between">
              <p className="font-medium text-zinc-900 dark:text-zinc-50">
                Week {week.weekNumber} · {formatDate(week.startDate)}–{formatDate(week.endDate)}
              </p>
              <span className="text-xs text-zinc-400">{week.estimatedMinutes} min</span>
            </div>
            <p className="mt-1 text-zinc-600 dark:text-zinc-300">{week.focusSummary}</p>
            <p className="mt-1 text-xs text-zinc-400">{week.reason}</p>
          </li>
        ))}
      </ul>

      {milestones.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-medium text-zinc-500">Milestones</h2>
          <ul className="mt-2 space-y-1">
            {milestones.map((m) => (
              <li key={m.id} className="flex items-center gap-2 text-sm">
                <span>{m.status === "COMPLETED" ? "✓" : "○"}</span>
                <span className={m.status === "COMPLETED" ? "text-zinc-400 line-through" : "text-zinc-700 dark:text-zinc-300"}>{m.title}</span>
                {m.scheduledDate && <span className="text-xs text-zinc-400">by {formatDate(m.scheduledDate)}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {Array.isArray(roadmap.recommendations) && roadmap.recommendations.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-medium text-zinc-500">Recommendations</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
            {(roadmap.recommendations as string[]).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      )}

      {Array.isArray(roadmap.risks) && roadmap.risks.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-medium text-zinc-500">Risks</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
            {(roadmap.risks as string[]).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
