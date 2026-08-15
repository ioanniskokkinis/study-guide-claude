import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse } from "@/lib/services/courses";
import { getCourseMastery, bucketForStatus } from "@/lib/services/student-knowledge";
import { getReviewState } from "@/lib/review/review-queries";
import { AdaptiveDashboard } from "@/components/study/AdaptiveDashboard";
import { ExamGoalForm } from "@/components/study/ExamGoalForm";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function StudyDashboardPage({ params }: PageProps) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();
  const course = await findOwnedCourse(user.id, courseId);
  if (!course) notFound();

  const [mastery, reviewState] = await Promise.all([
    getCourseMastery(user.id, courseId),
    getReviewState(user.id, courseId),
  ]);
  const concepts = mastery?.concepts ?? [];
  const hasKnowledgeGraph = course.knowledgeStatus === "READY" && concepts.length > 0;
  const practicedConcepts = concepts.filter((c) => c.exposureCount > 0);
  const allStrong =
    practicedConcepts.length > 0 && practicedConcepts.every((c) => bucketForStatus(c.status) === "strong");

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <Link href={`/courses/${course.id}`} className="text-sm text-zinc-500 hover:underline">
        ← {course.title}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        What should I study now?
      </h1>

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
                        {reviewState.reviewStreak} day{reviewState.reviewStreak === 1 ? "" : "s"} streak
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

          <div className="mt-6">
            <AdaptiveDashboard courseId={course.id} concepts={concepts.map((c) => ({ id: c.conceptId, name: c.conceptName, mastery: c.overallMastery, exposureCount: c.exposureCount }))} />
            <ExamGoalForm courseId={course.id} />
            <Link href={`/courses/${course.id}/tutor`} className="mt-4 inline-block text-sm text-zinc-500 underline-offset-2 hover:underline">
              Or talk it through with the AI Tutor →
            </Link>
          </div>

          <div className="mt-10">
            <h2 className="text-sm font-medium text-zinc-500">Your Progress</h2>
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
