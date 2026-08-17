import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse } from "@/lib/services/courses";
import { OralExamRunner } from "@/components/exam/OralExamRunner";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function OralExamPage({ params }: PageProps) {
  const { id: courseId } = await params;
  const user = await getCurrentUser();
  const course = await findOwnedCourse(user.id, courseId);
  if (!course) notFound();

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-10">
      <Link href={`/courses/${course.id}/exam`} className="focus-ring text-sm text-fg-muted hover:text-fg hover:underline">
        ← Exam
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">Oral Exam</h1>
      <div className="mt-6">
        <OralExamRunner courseId={course.id} />
      </div>
    </div>
  );
}
