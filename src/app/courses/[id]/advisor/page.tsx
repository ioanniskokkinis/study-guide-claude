import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse, getCourseWithDocuments } from "@/lib/services/courses";
import { listFolders } from "@/lib/services/folders";
import { listRoadmaps } from "@/lib/advisor/queries";
import { StudyAdvisorForm } from "@/components/advisor/StudyAdvisorForm";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Study Advisor entry point (Phase 15 §22, §34). If an ACTIVE roadmap
 * already exists, this redirects straight to it — the plan itself is
 * always DB -> render, never generated on a page load (spec §52).
 * Otherwise this is the "build a roadmap" input form.
 */
export default async function AdvisorPage({ params }: PageProps) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();

  const course = await findOwnedCourse(user.id, courseId);
  if (!course) notFound();

  const roadmaps = await listRoadmaps(user.id, courseId);
  const activeRoadmap = roadmaps?.find((r) => r.status === "ACTIVE");
  if (activeRoadmap) {
    redirect(`/courses/${courseId}/advisor/${activeRoadmap.id}`);
  }

  const [courseWithDocuments, folders] = await Promise.all([
    getCourseWithDocuments(user.id, courseId),
    listFolders(user.id, courseId),
  ]);

  const readyDocuments = (courseWithDocuments?.documents ?? []).filter((d) => d.processingStatus === "READY");

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-10">
      <Link href={`/courses/${courseId}`} className="focus-ring text-sm text-fg-muted hover:text-fg hover:underline">
        ← {course.title}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">Study Advisor</h1>
      <p className="mt-1 text-sm text-fg-muted">
        Tell it your goal, deadline, and available time — it builds a personalized roadmap from your actual knowledge
        state and study material.
      </p>

      {readyDocuments.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon="🗺️"
            title="No processed study material yet"
            description="Upload documents before building a roadmap."
            action={
              <Link href={`/courses/${courseId}`} className="focus-ring rounded text-sm text-fg underline underline-offset-2">
                Upload documents
              </Link>
            }
          />
        </div>
      ) : (
        <div className="mt-8">
          <StudyAdvisorForm courseId={courseId} folders={folders ?? []} documents={readyDocuments} />
        </div>
      )}

      {roadmaps && roadmaps.length > 0 && (
        <div className="mt-10">
          <SectionHeader title="Previous roadmaps" />
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
            {roadmaps.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <Link href={`/courses/${courseId}/advisor/${r.id}`} className="focus-ring min-w-0 truncate rounded font-medium text-fg hover:underline">
                  {r.title}
                </Link>
                <span className="flex shrink-0 items-center gap-2 text-xs text-fg-subtle">
                  <Badge>{r.status}</Badge>v{r.version}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
