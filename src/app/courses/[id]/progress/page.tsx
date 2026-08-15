import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse } from "@/lib/services/courses";
import { getCourseAnalytics } from "@/lib/dashboard/analytics";
import { MasterySparkline } from "@/components/dashboard/MasterySparkline";
import { formatMasteryPercent } from "@/components/knowledge/mastery-status-label";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 text-center dark:border-zinc-800">
      <dt className="text-xs text-zinc-400">{label}</dt>
      <dd className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">{value}</dd>
    </div>
  );
}

function ConceptBar({ name, mastery }: { name: string; mastery: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span className="truncate">{name}</span>
        <span>{formatMasteryPercent(mastery)}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className="h-1.5 rounded-full bg-zinc-900 dark:bg-zinc-50" style={{ width: `${Math.round(mastery * 100)}%` }} />
      </div>
    </div>
  );
}

export default async function ProgressPage({ params }: PageProps) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();
  const course = await findOwnedCourse(user.id, courseId);
  if (!course) notFound();

  const analytics = await getCourseAnalytics(user.id, courseId);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Link href={`/courses/${course.id}`} className="text-sm text-zinc-500 hover:underline">
        ← {course.title}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Progress</h1>

      {!analytics || analytics.questionsAnswered === 0 ? (
        <p className="mt-6 rounded-lg border border-zinc-200 p-6 text-sm text-zinc-500 dark:border-zinc-800">
          No study activity yet — analytics will appear here once you start answering questions.
        </p>
      ) : (
        <>
          <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatCard label="Overall mastery" value={formatMasteryPercent(analytics.overallMastery)} />
            <StatCard label="Accuracy" value={analytics.accuracy == null ? "—" : formatMasteryPercent(analytics.accuracy)} />
            <StatCard label="Questions answered" value={String(analytics.questionsAnswered)} />
            <StatCard label="Study time" value={`${analytics.studyTimeMinutes} min`} />
            <StatCard label="Study streak" value={`${analytics.studyStreak} day${analytics.studyStreak === 1 ? "" : "s"}`} />
            <StatCard label="Concepts mastered" value={String(analytics.conceptsMastered)} />
            <StatCard label="Weak concepts" value={String(analytics.weakConcepts)} />
            <StatCard label="Reviews completed" value={String(analytics.reviewsCompleted)} />
            <StatCard label="Reviews due" value={String(analytics.reviewsDue)} />
          </dl>

          <div className="mt-8">
            <h2 className="text-sm font-medium text-zinc-500">Mastery over time</h2>
            <div className="mt-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <MasterySparkline trend={analytics.masteryTrend} />
            </div>
          </div>

          <div className="mt-8">
            <h2 className="text-sm font-medium text-zinc-500">Concept mastery</h2>
            {analytics.conceptMastery.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">No concepts yet.</p>
            ) : (
              <div className="mt-3 space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                {analytics.conceptMastery.map((c) => (
                  <ConceptBar key={c.conceptId} name={c.conceptName} mastery={c.overallMastery} />
                ))}
              </div>
            )}
          </div>

          <div className="mt-8">
            <h2 className="text-sm font-medium text-zinc-500">Review history</h2>
            <dl className="mt-3 grid grid-cols-4 gap-3 rounded-lg border border-zinc-200 p-4 text-center dark:border-zinc-800">
              <div>
                <dt className="text-xs text-red-500">Again</dt>
                <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{analytics.reviewOutcomeTally.again}</dd>
              </div>
              <div>
                <dt className="text-xs text-amber-500">Hard</dt>
                <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{analytics.reviewOutcomeTally.hard}</dd>
              </div>
              <div>
                <dt className="text-xs text-emerald-500">Good</dt>
                <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{analytics.reviewOutcomeTally.good}</dd>
              </div>
              <div>
                <dt className="text-xs text-sky-500">Easy</dt>
                <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{analytics.reviewOutcomeTally.easy}</dd>
              </div>
            </dl>
          </div>

          <div className="mt-8">
            <h2 className="text-sm font-medium text-zinc-500">Exam performance</h2>
            {analytics.examScores.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">No exams taken yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {analytics.examScores.map((e) => (
                  <li key={e.examId} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                    <Link href={`/courses/${course.id}/exam/${e.examId}/result`} className="font-medium text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-50">
                      {e.mode.charAt(0) + e.mode.slice(1).toLowerCase()} exam
                    </Link>
                    <span className="flex items-center gap-2">
                      <span className={e.passed ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
                        {Math.round(e.percentage * 100)}%
                      </span>
                      <span className="text-xs text-zinc-400">{new Date(e.gradedAt).toLocaleDateString()}</span>
                    </span>
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
