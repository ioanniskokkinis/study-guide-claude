import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse } from "@/lib/services/courses";
import { getCourseAnalytics } from "@/lib/dashboard/analytics";
import { MasterySparkline } from "@/components/dashboard/MasterySparkline";
import { formatMasteryPercent } from "@/components/knowledge/mastery-status-label";
import { Card } from "@/components/ui/Card";
import { StatCard } from "@/components/ui/StatCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

function ConceptBar({ name, mastery }: { name: string; mastery: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-fg-muted">
        <span className="truncate">{name}</span>
        <span>{formatMasteryPercent(mastery)}</span>
      </div>
      <div className="mt-1">
        <ProgressBar value={mastery} />
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
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <Link href={`/courses/${course.id}`} className="focus-ring text-sm text-fg-muted hover:text-fg hover:underline">
        ← {course.title}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">Progress</h1>

      {!analytics || analytics.questionsAnswered === 0 ? (
        <div className="mt-6">
          <EmptyState icon="📈" title="No study activity yet" description="Analytics will appear here once you start answering questions." />
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatCard label="Overall mastery" value={formatMasteryPercent(analytics.overallMastery)} />
            <StatCard label="Accuracy" value={analytics.accuracy == null ? "—" : formatMasteryPercent(analytics.accuracy)} />
            <StatCard label="Questions answered" value={analytics.questionsAnswered} />
            <StatCard label="Study time" value={`${analytics.studyTimeMinutes} min`} />
            <StatCard label="Study streak" value={`${analytics.studyStreak} day${analytics.studyStreak === 1 ? "" : "s"}`} />
            <StatCard label="Concepts mastered" value={analytics.conceptsMastered} tone="success" />
            <StatCard label="Weak concepts" value={analytics.weakConcepts} tone={analytics.weakConcepts > 0 ? "danger" : "neutral"} />
            <StatCard label="Reviews completed" value={analytics.reviewsCompleted} />
            <StatCard label="Reviews due" value={analytics.reviewsDue} tone={analytics.reviewsDue > 0 ? "warning" : "neutral"} />
          </div>

          <div className="mt-8">
            <SectionHeader title="Mastery over time" />
            <Card className="mt-3">
              <MasterySparkline trend={analytics.masteryTrend} />
            </Card>
          </div>

          <div className="mt-8">
            <SectionHeader title="Concept mastery" />
            {analytics.conceptMastery.length === 0 ? (
              <p className="mt-2 text-sm text-fg-muted">No concepts yet.</p>
            ) : (
              <Card className="mt-3 space-y-3">
                {analytics.conceptMastery.map((c) => (
                  <ConceptBar key={c.conceptId} name={c.conceptName} mastery={c.overallMastery} />
                ))}
              </Card>
            )}
          </div>

          <div className="mt-8">
            <SectionHeader title="Review history" />
            <div className="mt-3 grid grid-cols-4 gap-3">
              <StatCard label="Again" value={analytics.reviewOutcomeTally.again} tone={analytics.reviewOutcomeTally.again > 0 ? "danger" : "neutral"} />
              <StatCard label="Hard" value={analytics.reviewOutcomeTally.hard} tone={analytics.reviewOutcomeTally.hard > 0 ? "warning" : "neutral"} />
              <StatCard label="Good" value={analytics.reviewOutcomeTally.good} tone={analytics.reviewOutcomeTally.good > 0 ? "success" : "neutral"} />
              <StatCard label="Easy" value={analytics.reviewOutcomeTally.easy} tone={analytics.reviewOutcomeTally.easy > 0 ? "success" : "neutral"} />
            </div>
          </div>

          <div className="mt-8">
            <SectionHeader title="Exam performance" />
            {analytics.examScores.length === 0 ? (
              <p className="mt-2 text-sm text-fg-muted">No exams taken yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
                {analytics.examScores.map((e) => (
                  <li key={e.examId} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                    <Link href={`/courses/${course.id}/exam/${e.examId}/result`} className="focus-ring rounded font-medium text-fg underline-offset-2 hover:underline">
                      {e.mode.charAt(0) + e.mode.slice(1).toLowerCase()} exam
                    </Link>
                    <span className="flex items-center gap-2">
                      <Badge tone={e.passed ? "success" : "danger"}>{Math.round(e.percentage * 100)}%</Badge>
                      <span className="text-xs text-fg-subtle">{new Date(e.gradedAt).toLocaleDateString()}</span>
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
