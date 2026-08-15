import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse } from "@/lib/services/courses";
import { listExamHistory } from "@/lib/exam/exam-orchestrator";
import { calculateReadiness } from "@/lib/exam/exam-readiness";
import { ExamSetupForm } from "@/components/exam/ExamSetupForm";
import { ReadinessCard } from "@/components/exam/ReadinessCard";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ExamPage({ params }: PageProps) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();
  const course = await findOwnedCourse(user.id, courseId);
  if (!course) notFound();

  const hasKnowledgeGraph = course.knowledgeStatus === "READY";
  const [history, readiness] = await Promise.all([
    listExamHistory(user.id, courseId),
    hasKnowledgeGraph ? calculateReadiness(user.id, courseId) : Promise.resolve(null),
  ]);

  const resumable = history.find((e) => e.status === "ACTIVE" || e.status === "CREATED");

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <Link href={`/courses/${course.id}`} className="text-sm text-zinc-500 hover:underline">
        ← {course.title}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Exam</h1>

      {!hasKnowledgeGraph ? (
        <p className="mt-6 rounded-lg border border-zinc-200 p-6 text-sm text-zinc-500 dark:border-zinc-800">
          This course doesn&rsquo;t have a knowledge graph yet.{" "}
          <Link href={`/courses/${course.id}/knowledge`} className="underline underline-offset-2">
            Build it
          </Link>{" "}
          before you can take an exam.
        </p>
      ) : (
        <>
          {resumable && (
            <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/30">
              <p className="text-amber-900 dark:text-amber-200">You have an exam in progress.</p>
              <Link
                href={`/courses/${course.id}/exam/${resumable.id}`}
                className="mt-2 inline-block underline underline-offset-2 text-amber-900 dark:text-amber-200"
              >
                Resume it →
              </Link>
            </div>
          )}

          {readiness && <ReadinessCard readiness={readiness} />}

          <div className="mt-6">
            <ExamSetupForm courseId={course.id} />
          </div>

          <div className="mt-10">
            <h2 className="text-sm font-medium text-zinc-500">Exam History</h2>
            {history.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">No exams taken yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {history.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                    <div>
                      <Link
                        href={e.status === "GRADED" ? `/courses/${course.id}/exam/${e.id}/result` : `/courses/${course.id}/exam/${e.id}`}
                        className="font-medium text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-50"
                      >
                        {e.mode} {e.isRetest ? "(retest)" : ""} — {new Date(e.createdAt).toLocaleDateString()}
                      </Link>
                      <p className="text-xs text-zinc-400">{e.status}</p>
                    </div>
                    {e.percentage != null && (
                      <span className={e.passed ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
                        {Math.round(e.percentage * 100)}%
                      </span>
                    )}
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
