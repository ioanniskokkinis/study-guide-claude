import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getCourseWithDocuments } from "@/lib/services/courses";
import { listFolders } from "@/lib/services/folders";
import { getCourseMastery } from "@/lib/services/student-knowledge";
import { getReviewState } from "@/lib/review/review-queries";
import { rankWeakConcepts } from "@/lib/learning/weak-concepts";
import { getNextLearningAction, NoConceptsAvailableError } from "@/lib/learning/adaptive-engine";
import { DeleteCourseButton } from "@/components/courses/DeleteCourseButton";
import { KnowledgeHub } from "@/components/documents/KnowledgeHub";
import { MyKnowledgeSummaryCard } from "@/components/knowledge/MyKnowledgeSummaryCard";
import { Button } from "@/components/ui/Button";
import { SectionHeader } from "@/components/ui/SectionHeader";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CoursePage({ params }: PageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  const [course, mastery, folders, reviewState, weakConcepts] = await Promise.all([
    getCourseWithDocuments(user.id, id),
    getCourseMastery(user.id, id),
    listFolders(user.id, id),
    getReviewState(user.id, id),
    rankWeakConcepts(user.id, id),
  ]);

  if (!course) {
    notFound();
  }

  const recommendedAction = await getNextLearningAction({ userId: user.id, courseId: id })
    .then((r) => r.action)
    .catch((error) => {
      if (!(error instanceof NoConceptsAvailableError)) console.error("Failed to compute recommended next action:", error);
      return null;
    });

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      {/* Course header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/courses" className="focus-ring text-sm text-fg-muted hover:text-fg hover:underline">
            ← Courses
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">{course.title}</h1>
          {course.description && <p className="mt-1 text-sm text-fg-muted">{course.description}</p>}
        </div>
        <DeleteCourseButton courseId={course.id} redirectTo="/courses" />
      </div>

      {/* Quick navigation */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Link href={`/courses/${course.id}/knowledge`}>
          <Button variant="secondary">Knowledge Graph</Button>
        </Link>
        {course.knowledgeStatus === "READY" && (
          <>
            <Link href={`/courses/${course.id}/study`}>
              <Button variant="primary">Study</Button>
            </Link>
            <Link href={`/courses/${course.id}/tutor`}>
              <Button variant="secondary">Tutor</Button>
            </Link>
            <Link href={`/courses/${course.id}/exam`}>
              <Button variant="secondary">Exam</Button>
            </Link>
            <Link href={`/courses/${course.id}/review`}>
              <Button variant="secondary">Review</Button>
            </Link>
            <Link href={`/courses/${course.id}/advisor`}>
              <Button variant="secondary">Study Advisor</Button>
            </Link>
          </>
        )}
      </div>

      {/* Current state -> Recommended action -> Learning areas */}
      {mastery && (
        <div className="mt-8">
          <MyKnowledgeSummaryCard
            courseId={course.id}
            mastery={mastery}
            dueCount={reviewState?.dueCount}
            weakConcepts={weakConcepts ?? undefined}
            recommendedAction={recommendedAction}
          />
        </div>
      )}

      {/* Materials */}
      <div className="mt-10">
        <SectionHeader title="Documents" className="mb-3" />
        <KnowledgeHub courseId={course.id} initialFolders={folders ?? []} initialDocuments={course.documents} />
      </div>
    </div>
  );
}
