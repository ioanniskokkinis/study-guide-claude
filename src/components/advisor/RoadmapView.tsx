"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { getRoadmap, getTodayPlan } from "@/lib/advisor/queries";
import type { RoadmapProgress } from "@/lib/advisor/progress";
import type { HealthResult, RoadmapHealth } from "@/lib/advisor/health";
import type { AdaptationCheckResult } from "@/lib/advisor/change-detection";
import type { NextBestActionResult } from "@/lib/advisor/next-action";
import type { RoadmapChangeSummary } from "@/lib/advisor/diff";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { InlineError } from "@/components/ui/ErrorState";

type Roadmap = NonNullable<Awaited<ReturnType<typeof getRoadmap>>>;
type TodayPlan = NonNullable<Awaited<ReturnType<typeof getTodayPlan>>>;

const HEALTH_LABEL: Record<RoadmapHealth, string> = {
  ON_TRACK: "Your plan is on track.",
  AT_RISK: "You're slightly behind schedule.",
  BEHIND: "You're behind schedule. We've adjusted the next few sessions.",
  INSUFFICIENT_DATA: "Not enough data yet to tell if you're on track.",
};

const HEALTH_TONE: Record<RoadmapHealth, BadgeTone> = {
  ON_TRACK: "success",
  AT_RISK: "warning",
  BEHIND: "danger",
  INSUFFICIENT_DATA: "neutral",
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
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{roadmap.title}</h1>
          <p className="mt-1 text-sm text-fg-muted">{roadmap.goal}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {roadmap.status === "ACTIVE" && (
            <>
              <Button variant="secondary" size="sm" onClick={handlePause} disabled={pausing}>
                Pause
              </Button>
              <Button variant="secondary" size="sm" loading={replanning} onClick={handleReplan}>
                {replanning ? "Replanning…" : "Replan"}
              </Button>
            </>
          )}
          {roadmap.status === "PAUSED" && (
            <Button variant="secondary" size="sm" loading={pausing} onClick={handleResume}>
              {pausing ? "Resuming…" : "Resume"}
            </Button>
          )}
          <a href={`/api/roadmaps/${roadmap.id}/pdf`} target="_blank" rel="noreferrer">
            <Button variant="primary" size="sm">
              Export PDF
            </Button>
          </a>
        </div>
      </div>
      {error && (
        <div className="mt-2">
          <InlineError message={error} />
        </div>
      )}
      {resumeNote && <p className="mt-2 text-sm text-fg-muted">{resumeNote}</p>}

      <div className="mt-4">
        <Badge tone={HEALTH_TONE[health.health]}>{HEALTH_LABEL[health.health]}</Badge>
      </div>

      {adaptation?.needed && (
        <Card className="mt-4 border-warning-border bg-warning-bg">
          <p className="font-medium text-warning-fg">Your study plan may need an update.</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-warning-fg/90">
            {adaptation.details.map((detail, i) => (
              <li key={i}>{detail}</li>
            ))}
          </ul>
          {roadmap.status === "ACTIVE" && (
            <div className="mt-3">
              <Button variant="primary" size="sm" loading={replanning} onClick={handleReplan}>
                {replanning ? "Updating…" : "Review and update my plan"}
              </Button>
            </div>
          )}
        </Card>
      )}

      {changeSummary && (changeSummary.removed.length > 0 || changeSummary.movedEarlier.length > 0 || changeSummary.added.length > 0) && (
        <Card className="mt-4">
          <p className="font-medium text-fg">What changed in this plan</p>
          {roadmap.adaptationReason && <p className="mt-1 text-sm text-fg-muted">{roadmap.adaptationReason}</p>}
          {changeSummary.added.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-fg-subtle">Added</p>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-fg">
                {changeSummary.added.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {changeSummary.movedEarlier.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-fg-subtle">Moved earlier</p>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-fg">
                {changeSummary.movedEarlier.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {changeSummary.removed.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-fg-subtle">No longer needed</p>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-fg">
                {changeSummary.removed.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      <Card className="mt-6">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-fg-subtle">Deadline</dt>
            <dd className="mt-0.5 font-medium text-fg">{roadmap.deadline ? formatDate(roadmap.deadline) : "None set"}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-subtle">Study material</dt>
            <dd className="mt-0.5 truncate font-medium text-fg">{scopeLabel}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-subtle">Progress</dt>
            <dd className="mt-0.5 font-medium text-fg">{pct(progress.overallProgressPercent)}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-subtle">Current knowledge</dt>
            <dd className="mt-0.5 font-medium text-fg">{pct(progress.currentAverageMasteryPercent)} mastery</dd>
          </div>
        </dl>
      </Card>

      <div className="mt-3">
        <ProgressBar value={progress.overallProgressPercent} label="Roadmap progress" />
        <p className="mt-1 text-xs text-fg-subtle">
          {progress.completedItems}/{progress.totalItems} items complete
          {progress.overdueItems > 0 ? ` · ${progress.overdueItems} overdue` : ""}
        </p>
      </div>

      {roadmap.summary && <p className="mt-6 text-sm text-fg">{roadmap.summary}</p>}

      <div className="mt-8">
        <SectionHeader title="Today's plan" />
        {todayPlan.today.length === 0 && todayPlan.overdue.length === 0 ? (
          <p className="mt-2 text-sm text-fg-muted">Nothing scheduled today. Enjoy the rest.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
            {[...todayPlan.overdue, ...todayPlan.today].map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <input
                  type="checkbox"
                  checked={item.status === "COMPLETED"}
                  disabled={pendingItemId === item.id}
                  onChange={() => markItem(item.id, item.status === "COMPLETED" ? "PENDING" : "COMPLETED")}
                  aria-label={`Mark "${item.title}" complete`}
                  className="focus-ring accent-accent"
                />
                <div className="min-w-0 flex-1">
                  <p className={item.status === "COMPLETED" ? "truncate font-medium text-fg-subtle line-through" : "truncate font-medium text-fg"}>
                    {ACTION_LABEL[item.action] ?? item.action}: {item.title}
                  </p>
                  <p className="truncate text-xs text-fg-subtle">
                    {item.estimatedMinutes} min
                    {item.scheduledDate && new Date(item.scheduledDate) < new Date(new Date().setHours(0, 0, 0, 0)) ? " · overdue" : ""}
                    {item.reason ? ` — ${item.reason}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Card className="mt-6">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-fg">Not sure where to start?</p>
          <Button variant="primary" size="sm" loading={loadingNextAction} onClick={handleWhatsNext}>
            {loadingNextAction ? "Thinking…" : "What should I study now?"}
          </Button>
        </div>
        {nextAction && (
          <div className="mt-3 text-sm">
            {nextAction.type === "NONE" ? (
              <p className="text-fg-muted">{nextAction.reason}</p>
            ) : (
              <>
                <p className="font-medium text-fg">
                  {NEXT_ACTION_LABEL[nextAction.type] ?? nextAction.type}: {nextAction.conceptName}
                </p>
                <p className="mt-0.5 text-xs text-fg-subtle">
                  {nextAction.durationMinutes} min — {nextAction.reason}
                </p>
              </>
            )}
          </div>
        )}
      </Card>

      <div className="mt-8">
        <SectionHeader title="Priority topics" />
        <ul className="mt-2 space-y-2">
          {priorityItems.map((item) => (
            <li key={item.id}>
              <Card padding="sm">
                <p className="font-medium text-fg">{item.title}</p>
                <p className="mt-0.5 text-xs text-fg-subtle">{item.reason}</p>
              </Card>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-8">
        <SectionHeader title="Weekly roadmap" />
        <ul className="mt-2 space-y-3">
          {roadmap.weeks.map((week) => (
            <li key={week.id}>
              <Card padding="sm">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-fg">
                    Week {week.weekNumber} · {formatDate(week.startDate)}–{formatDate(week.endDate)}
                  </p>
                  <span className="text-xs text-fg-subtle">{week.estimatedMinutes} min</span>
                </div>
                <p className="mt-1 text-sm text-fg-muted">{week.focusSummary}</p>
                <p className="mt-1 text-xs text-fg-subtle">{week.reason}</p>
              </Card>
            </li>
          ))}
        </ul>
      </div>

      {milestones.length > 0 && (
        <div className="mt-8">
          <SectionHeader title="Milestones" />
          <ul className="mt-2 space-y-1">
            {milestones.map((m) => (
              <li key={m.id} className="flex items-center gap-2 text-sm">
                <span>{m.status === "COMPLETED" ? "✓" : "○"}</span>
                <span className={m.status === "COMPLETED" ? "text-fg-subtle line-through" : "text-fg"}>{m.title}</span>
                {m.scheduledDate && <span className="text-xs text-fg-subtle">by {formatDate(m.scheduledDate)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {Array.isArray(roadmap.recommendations) && roadmap.recommendations.length > 0 && (
        <div className="mt-8">
          <SectionHeader title="Recommendations" />
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-fg">
            {(roadmap.recommendations as string[]).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {Array.isArray(roadmap.risks) && roadmap.risks.length > 0 && (
        <div className="mt-8">
          <SectionHeader title="Risks" />
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-fg">
            {(roadmap.risks as string[]).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
