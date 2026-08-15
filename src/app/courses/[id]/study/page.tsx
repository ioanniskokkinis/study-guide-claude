import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse } from "@/lib/services/courses";
import { getCourseMastery, bucketForStatus } from "@/lib/services/student-knowledge";
import { getReviewState } from "@/lib/review/review-queries";
import { getTodaysStudyPlan, type StudyPlanItem } from "@/lib/dashboard/study-plan";
import { getStudyNotifications, type StudyNotification } from "@/lib/dashboard/notifications";
import { getStudyStreak } from "@/lib/dashboard/streak";
import { AdaptiveDashboard } from "@/components/study/AdaptiveDashboard";
import { ExamGoalForm } from "@/components/study/ExamGoalForm";

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

const NOTIFICATION_STYLE: Record<StudyNotification["level"], string> = {
  info: "bg-zinc-50 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300",
  warning: "bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300",
  success: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300",
};

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
    <div className="mx-auto max-w-2xl px-6 py-10">
      <Link href={`/courses/${course.id}`} className="text-sm text-zinc-500 hover:underline">
        ← {course.title}
      </Link>
      <div className="mt-1 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {greeting(now)} 👋
        </h1>
        {studyStreak > 0 && (
          <span className="shrink-0 text-sm font-medium text-zinc-500">
            🔥 {studyStreak} day{studyStreak === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {mastery && practicedConcepts.length > 0 && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>Overall progress</span>
            <span>{Math.round(mastery.overallMastery * 100)}%</span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-zinc-200 dark:bg-zinc-800">
            <div className="h-2 rounded-full bg-zinc-900 dark:bg-zinc-50" style={{ width: `${Math.round(mastery.overallMastery * 100)}%` }} />
          </div>
        </div>
      )}

      {notifications.length > 0 && (
        <div className="mt-4 space-y-2">
          {notifications.map((n) => (
            <p key={n.id} className={`rounded-md px-4 py-2 text-sm ${NOTIFICATION_STYLE[n.level]}`}>
              {n.message}
            </p>
          ))}
        </div>
      )}

      {!hasKnowledgeGraph ? (
        <p className="mt-6 rounded-lg border border-zinc-200 p-6 text-sm text-zinc-500 dark:border-zinc-800">
          This course doesn&rsquo;t have a knowledge graph yet.{" "}
          <Link href={`/courses/${course.id}/knowledge`} className="underline underline-offset-2">
            Build it
          </Link>{" "}
          before the adaptive engine can recommend anything.
        </p>
      ) : (
        <>
          {allStrong && (
            <p className="mt-4 rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
              You&rsquo;re doing well across this course — recommendations will lean toward challenge and retention
              rather than new material.
            </p>
          )}

          {studyPlan.length > 0 && (
            <div className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                Today&rsquo;s Plan — {studyPlan.reduce((sum, item) => sum + item.estimatedMinutes, 0)} minutes
              </h2>
              <ul className="mt-2 space-y-1.5">
                {studyPlan.map((item, i) => (
                  <li key={`${item.kind}-${item.conceptId ?? i}`} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span>{planIcon(item)}</span>
                      <span className="truncate text-zinc-700 dark:text-zinc-300">{item.label}</span>
                    </span>
                    <span className="shrink-0 text-xs text-zinc-400">{item.estimatedMinutes} min</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {reviewState && (
            <div className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-50">Reviews</h2>
                  <p className="mt-1 text-sm text-zinc-500">
                    Due now: <span className="font-medium text-zinc-700 dark:text-zinc-300">{reviewState.dueCount}</span>
                    {" · "}
                    Overdue: <span className="font-medium text-zinc-700 dark:text-zinc-300">{reviewState.overdueCount}</span>
                    {reviewState.reviewStreak > 0 && (
                      <>
                        {" · "}
                        {reviewState.reviewStreak} day{reviewState.reviewStreak === 1 ? "" : "s"} review streak
                      </>
                    )}
                  </p>
                </div>
                <Link
                  href={`/courses/${course.id}/review`}
                  className="shrink-0 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                >
                  Start Review
                </Link>
              </div>
            </div>
          )}

          {weakConcepts.length > 0 && (
            <div className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-50">Weak Areas</h2>
              <ul className="mt-2 space-y-1">
                {weakConcepts
                  .slice()
                  .sort((a, b) => a.overallMastery - b.overallMastery)
                  .map((c) => (
                    <li key={c.conceptId} className="flex items-center justify-between text-sm">
                      <Link href={`/concepts/${c.conceptId}`} className="text-zinc-700 underline-offset-2 hover:underline dark:text-zinc-300">
                        ⚠ {c.conceptName}
                      </Link>
                      <span className="text-amber-600 dark:text-amber-400">{Math.round(c.overallMastery * 100)}%</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <div className="mt-6">
            <AdaptiveDashboard courseId={course.id} concepts={concepts.map((c) => ({ id: c.conceptId, name: c.conceptName, mastery: c.overallMastery, exposureCount: c.exposureCount }))} />
            <ExamGoalForm courseId={course.id} />
            <Link href={`/courses/${course.id}/tutor`} className="mt-4 inline-block text-sm text-zinc-500 underline-offset-2 hover:underline">
              Or talk it through with the AI Tutor →
            </Link>
          </div>

          <div className="mt-10">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-zinc-500">Your Progress</h2>
              <Link href={`/courses/${course.id}/progress`} className="text-xs font-medium text-zinc-500 underline-offset-2 hover:underline">
                Full analytics →
              </Link>
            </div>
            {concepts.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">No concepts yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {concepts
                  .slice()
                  .sort((a, b) => b.overallMastery - a.overallMastery)
                  .map((c) => (
                    <li key={c.conceptId} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                      <Link
                        href={`/concepts/${c.conceptId}`}
                        className="font-medium text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-50"
                      >
                        {c.conceptName}
                      </Link>
                      <span className="text-zinc-500">{Math.round(c.overallMastery * 100)}%</span>
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
