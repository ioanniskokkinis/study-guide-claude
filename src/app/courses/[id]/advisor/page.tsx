import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse, getCourseWithDocuments } from "@/lib/services/courses";
import { listFolders } from "@/lib/services/folders";
import { listRoadmaps } from "@/lib/advisor/queries";
import { StudyAdvisorForm } from "@/components/advisor/StudyAdvisorForm";

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
    <div className="mx-auto max-w-2xl px-6 py-10">
      <Link href={`/courses/${courseId}`} className="text-sm text-zinc-500 hover:underline">
        ← {course.title}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Study Advisor</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Tell it your goal, deadline, and available time — it builds a personalized roadmap from your actual knowledge
        state and study material.
      </p>

      {readyDocuments.length === 0 ? (
        <div className="mt-8 rounded-lg border border-zinc-200 p-6 text-sm text-zinc-500 dark:border-zinc-800">
          You don&rsquo;t have any processed study material yet.{" "}
          <Link href={`/courses/${courseId}`} className="underline underline-offset-2">
            Upload documents
          </Link>{" "}
          before building a roadmap.
        </div>
      ) : (
        <div className="mt-8">
          <StudyAdvisorForm courseId={courseId} folders={folders ?? []} documents={readyDocuments} />
        </div>
      )}

      {roadmaps && roadmaps.length > 0 && (
        <div className="mt-10">
          <h2 className="text-sm font-medium text-zinc-500">Previous roadmaps</h2>
          <ul className="mt-2 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {roadmaps.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <Link href={`/courses/${courseId}/advisor/${r.id}`} className="min-w-0 truncate font-medium text-zinc-900 hover:underline dark:text-zinc-50">
                  {r.title}
                </Link>
                <span className="shrink-0 text-xs text-zinc-400">
                  {r.status} · v{r.version}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
