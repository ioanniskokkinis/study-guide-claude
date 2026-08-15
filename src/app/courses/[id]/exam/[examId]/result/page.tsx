import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse } from "@/lib/services/courses";
import { getExamResult } from "@/lib/exam/exam-orchestrator";
import { ExamResultView } from "@/components/exam/ExamResultView";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; examId: string }>;
}

export default async function ExamResultPage({ params }: PageProps) {
  const { id: courseId, examId } = await params;
  const user = await getCurrentUser();
  const course = await findOwnedCourse(user.id, courseId);
  if (!course) notFound();

  const result = await getExamResult(examId, user.id);
  if (!result) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <Link href={`/courses/${course.id}/exam`} className="text-sm text-zinc-500 hover:underline">
          ← Exam
        </Link>
        <p className="mt-6 text-sm text-zinc-500">This exam hasn&rsquo;t been graded yet.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <Link href={`/courses/${course.id}/exam`} className="text-sm text-zinc-500 hover:underline">
        ← Exam
      </Link>
      <ExamResultView courseId={course.id} result={result} />
    </div>
  );
}
