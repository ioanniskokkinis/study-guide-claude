import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse } from "@/lib/services/courses";
import { ExamRunner } from "@/components/exam/ExamRunner";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; examId: string }>;
}

export default async function ExamRunnerPage({ params }: PageProps) {
  const { id: courseId, examId } = await params;
  const user = await getCurrentUser();
  const course = await findOwnedCourse(user.id, courseId);
  if (!course) notFound();

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <ExamRunner courseId={course.id} examId={examId} />
    </div>
  );
}
