import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getCourseWithDocuments } from "@/lib/services/courses";
import { getCourseMastery } from "@/lib/services/student-knowledge";
import { UploadPdfForm } from "@/components/documents/UploadPdfForm";
import { DeleteCourseButton } from "@/components/courses/DeleteCourseButton";
import { DeleteDocumentButton } from "@/components/documents/DeleteDocumentButton";
import { MyKnowledgeSummaryCard } from "@/components/knowledge/MyKnowledgeSummaryCard";
import { statusLabel } from "@/components/documents/status-label";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CoursePage({ params }: PageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  const [course, mastery] = await Promise.all([
    getCourseWithDocuments(user.id, id),
    getCourseMastery(user.id, id),
  ]);

  if (!course) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/courses" className="text-sm text-zinc-500 hover:underline">
            ← Courses
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {course.title}
          </h1>
          {course.description && (
            <p className="mt-1 text-sm text-zinc-500">{course.description}</p>
          )}
        </div>
        <DeleteCourseButton courseId={course.id} redirectTo="/courses" />
      </div>

      <div className="mt-6 flex items-center gap-3">
        <UploadPdfForm courseId={course.id} />
        <Link
          href={`/courses/${course.id}/knowledge`}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
        >
          Knowledge Graph
        </Link>
        {course.knowledgeStatus === "READY" && (
          <>
            <Link
              href={`/courses/${course.id}/study`}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Study
            </Link>
            <Link
              href={`/courses/${course.id}/exam`}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
            >
              Exam
            </Link>
          </>
        )}
      </div>

      {mastery && (
        <div className="mt-8">
          <MyKnowledgeSummaryCard courseId={course.id} mastery={mastery} />
        </div>
      )}

      <h2 className="mt-8 text-sm font-medium text-zinc-500">Documents</h2>
      {course.documents.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">No documents yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {course.documents.map((document) => {
            const status = statusLabel(document.processingStatus);
            return (
              <li
                key={document.id}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0">
                  <Link
                    href={`/courses/${course.id}/documents/${document.id}`}
                    className="font-medium text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-50"
                  >
                    {document.originalFilename}
                  </Link>
                  <p className="truncate text-xs text-zinc-400">
                    {document._count.chunks} chunk
                    {document._count.chunks === 1 ? "" : "s"}
                    {document.processingError ? ` — ${document.processingError}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className={`text-sm font-medium ${status.className}`}>
                    {status.label}
                  </span>
                  <DeleteDocumentButton documentId={document.id} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
