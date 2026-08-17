import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse } from "@/lib/services/courses";
import { listExamHistory } from "@/lib/exam/exam-orchestrator";
import { calculateReadiness } from "@/lib/exam/exam-readiness";
import { ExamSetupForm } from "@/components/exam/ExamSetupForm";
import { ReadinessCard } from "@/components/exam/ReadinessCard";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";

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
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-10">
      <Link href={`/courses/${course.id}`} className="focus-ring text-sm text-fg-muted hover:text-fg hover:underline">
        ← {course.title}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">Exam</h1>

      {!hasKnowledgeGraph ? (
        <div className="mt-6">
          <EmptyState
            icon="📚"
            title="No knowledge graph yet"
            description="Build the knowledge graph before you can take an exam."
            action={
              <Link href={`/courses/${course.id}/knowledge`} className="focus-ring rounded text-sm text-fg underline underline-offset-2">
                Build it →
              </Link>
            }
          />
        </div>
      ) : (
        <>
          {resumable && (
            <Card className="mt-6 border-warning-border bg-warning-bg">
              <p className="text-sm text-warning-fg">You have an exam in progress.</p>
              <Link href={`/courses/${course.id}/exam/${resumable.id}`} className="focus-ring mt-2 inline-block rounded text-sm text-warning-fg underline underline-offset-2">
                Resume it →
              </Link>
            </Card>
          )}

          {readiness && <ReadinessCard readiness={readiness} />}

          <div className="mt-6">
            <ExamSetupForm courseId={course.id} />
          </div>

          <div className="mt-10">
            <SectionHeader title="Exam History" />
            {history.length === 0 ? (
              <p className="mt-2 text-sm text-fg-muted">No exams taken yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
                {history.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                    <div>
                      <Link
                        href={e.status === "GRADED" ? `/courses/${course.id}/exam/${e.id}/result` : `/courses/${course.id}/exam/${e.id}`}
                        className="focus-ring rounded font-medium text-fg underline-offset-2 hover:underline"
                      >
                        {e.mode} {e.isRetest ? "(retest)" : ""} — {new Date(e.createdAt).toLocaleDateString()}
                      </Link>
                      <p className="text-xs text-fg-subtle">{e.status}</p>
                    </div>
                    {e.percentage != null && <Badge tone={e.passed ? "success" : "danger"}>{Math.round(e.percentage * 100)}%</Badge>}
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
