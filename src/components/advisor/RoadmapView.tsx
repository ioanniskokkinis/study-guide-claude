"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { getRoadmap, getTodayPlan } from "@/lib/advisor/queries";
import type { RoadmapProgress } from "@/lib/advisor/progress";

type Roadmap = NonNullable<Awaited<ReturnType<typeof getRoadmap>>>;
type TodayPlan = NonNullable<Awaited<ReturnType<typeof getTodayPlan>>>;

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
}: {
  courseId: string;
  roadmap: Roadmap;
  progress: RoadmapProgress;
  todayPlan: TodayPlan;
}) {
  const router = useRouter();
  const [replanning, setReplanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);

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

  return (
    <div className="mt-2">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{roadmap.title}</h1>
          <p className="mt-1 text-sm text-zinc-500">{roadmap.goal}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {roadmap.status === "ACTIVE" && (
            <button
              type="button"
              onClick={handleReplan}
              disabled={replanning}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
            >
              {replanning ? "Replanning…" : "Replan"}
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
