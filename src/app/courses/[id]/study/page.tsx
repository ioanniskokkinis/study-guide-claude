import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse } from "@/lib/services/courses";
import { getCourseMastery, bucketForStatus } from "@/lib/services/student-knowledge";
import { getReviewState } from "@/lib/review/review-queries";
import { getTodaysStudyPlan, type StudyPlanItem } from "@/lib/dashboard/study-plan";
import { getStudyNotifications } from "@/lib/dashboard/notifications";
import { getStudyStreak } from "@/lib/dashboard/streak";
import { AdaptiveDashboard } from "@/components/study/AdaptiveDashboard";
import { ExamGoalForm } from "@/components/study/ExamGoalForm";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

const PLAN_ICON: Record<string, string> = {
  REVIEW: "🔄",
  ACTIVE_RECALL: "🔴",
  REMEDIATION: "🔴",
  PREREQUISITE_REVIEW: "🟠",
  CHALLENGE: "🟢",
};

function planIcon(item: StudyPlanItem): string {
  if (item.kind === "REVIEW") return PLAN_ICON.REVIEW;
  return PLAN_ICON[item.actionType ?? ""] ?? "📝";
}

export default async function StudyDashboardPage({ params }: PageProps) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();
  const course = await findOwnedCourse(user.id, courseId);
  if (!course) notFound();

  const now = new Date();
  const [mastery, reviewState, studyPlan, notifications, studyStreak] = await Promise.all([
    getCourseMastery(user.id, courseId),
    getReviewState(user.id, courseId, now),
    getTodaysStudyPlan(user.id, courseId),
    getStudyNotifications(user.id, courseId, now),
    getStudyStreak(user.id, courseId, now),
  ]);
  const concepts = mastery?.concepts ?? [];
  const hasKnowledgeGraph = course.knowledgeStatus === "READY" && concepts.length > 0;
  const practicedConcepts = concepts.filter((c) => c.exposureCount > 0);
  const allStrong =
    practicedConcepts.length > 0 && practicedConcepts.every((c) => bucketForStatus(c.status) === "strong");
  const weakConcepts = practicedConcepts.filter((c) => bucketForStatus(c.status) === "weak");

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-10">
      <Link href={`/courses/${course.id}`} className="focus-ring text-sm text-fg-muted hover:text-fg hover:underline">
        ← {course.title}
      </Link>
      <div className="mt-1 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{greeting(now)} 👋</h1>
        {studyStreak > 0 && (
          <span className="shrink-0 text-sm font-medium text-fg-muted">
            🔥 {studyStreak} day{studyStreak === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {mastery && practicedConcepts.length > 0 && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-fg-muted">
            <span>Overall progress</span>
            <span>{Math.round(mastery.overallMastery * 100)}%</span>
          </div>
          <div className="mt-1">
            <ProgressBar value={mastery.overallMastery} />
          </div>
        </div>
      )}

      {notifications.length > 0 && (
        <div className="mt-4 space-y-2">
          {notifications.map((n) => (
            <div key={n.id} className={`rounded-md px-4 py-2 text-sm ${n.level === "warning" ? "bg-warning-bg text-warning-fg" : n.level === "success" ? "bg-success-bg text-success-fg" : "bg-surface-muted text-fg"}`}>
              {n.message}
            </div>
          ))}
        </div>
      )}

      {!hasKnowledgeGraph ? (
        <div className="mt-6">
          <EmptyState
            icon="📚"
            title="No knowledge graph yet"
            description="Build the knowledge graph before the adaptive engine can recommend anything."
            action={
              <Link href={`/courses/${course.id}/knowledge`} className="focus-ring rounded text-sm text-fg underline underline-offset-2">
                Build it →
              </Link>
            }
          />
        </div>
      ) : (
        <>
          {allStrong && (
            <div className="mt-4 rounded-md bg-success-bg px-4 py-3 text-sm text-success-fg">
              You&rsquo;re doing well across this course — recommendations will lean toward challenge and retention
              rather than new material.
            </div>
          )}

          {studyPlan.length > 0 && (
            <Card className="mt-6">
              <h2 className="text-sm font-medium text-fg">
                Today&rsquo;s Plan — {studyPlan.reduce((sum, item) => sum + item.estimatedMinutes, 0)} minutes
              </h2>
              <ul className="mt-2 space-y-1.5">
                {studyPlan.map((item, i) => (
                  <li key={`${item.kind}-${item.conceptId ?? i}`} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span>{planIcon(item)}</span>
                      <span className="truncate text-fg-muted">{item.label}</span>
                    </span>
                    <span className="shrink-0 text-xs text-fg-subtle">{item.estimatedMinutes} min</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {reviewState && (
            <Card className="mt-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-sm font-medium text-fg">Reviews</h2>
                  <p className="mt-1 text-sm text-fg-muted">
                    Due now: <span className="font-medium text-fg">{reviewState.dueCount}</span>
                    {" · "}
                    Overdue: <span className="font-medium text-fg">{reviewState.overdueCount}</span>
                    {reviewState.reviewStreak > 0 && (
                      <>
                        {" · "}
                        {reviewState.reviewStreak} day{reviewState.reviewStreak === 1 ? "" : "s"} review streak
                      </>
                    )}
                  </p>
                </div>
                <Link href={`/courses/${course.id}/review`}>
                  <Button variant="primary" size="sm">
                    Start Review
                  </Button>
                </Link>
              </div>
            </Card>
          )}

          {weakConcepts.length > 0 && (
            <Card className="mt-6">
              <h2 className="text-sm font-medium text-fg">Weak Areas</h2>
              <ul className="mt-2 space-y-1">
                {weakConcepts
                  .slice()
                  .sort((a, b) => a.overallMastery - b.overallMastery)
                  .map((c) => (
                    <li key={c.conceptId} className="flex items-center justify-between text-sm">
                      <Link href={`/concepts/${c.conceptId}`} className="focus-ring rounded text-fg-muted underline-offset-2 hover:text-fg hover:underline">
                        ⚠ {c.conceptName}
                      </Link>
                      <Badge tone="warning">{Math.round(c.overallMastery * 100)}%</Badge>
                    </li>
                  ))}
              </ul>
            </Card>
          )}

          <div className="mt-6">
            <AdaptiveDashboard courseId={course.id} concepts={concepts.map((c) => ({ id: c.conceptId, name: c.conceptName, mastery: c.overallMastery, exposureCount: c.exposureCount }))} />
            <ExamGoalForm courseId={course.id} />
            <Link href={`/courses/${course.id}/tutor`} className="focus-ring mt-4 inline-block rounded text-sm text-fg-muted underline-offset-2 hover:text-fg hover:underline">
              Or talk it through with the AI Tutor →
            </Link>
          </div>

          <div className="mt-10">
            <SectionHeader
              title="Your Progress"
              action={
                <Link href={`/courses/${course.id}/progress`} className="focus-ring rounded text-xs font-medium text-fg-muted underline-offset-2 hover:text-fg hover:underline">
                  Full analytics →
                </Link>
              }
            />
            {concepts.length === 0 ? (
              <p className="mt-2 text-sm text-fg-muted">No concepts yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
                {concepts
                  .slice()
                  .sort((a, b) => b.overallMastery - a.overallMastery)
                  .map((c) => (
                    <li key={c.conceptId} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                      <Link href={`/concepts/${c.conceptId}`} className="focus-ring rounded font-medium text-fg underline-offset-2 hover:underline">
                        {c.conceptName}
                      </Link>
                      <span className="text-fg-muted">{Math.round(c.overallMastery * 100)}%</span>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
