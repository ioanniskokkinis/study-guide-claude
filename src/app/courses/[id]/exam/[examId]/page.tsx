import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse } from "@/lib/services/courses";
import { prisma } from "@/lib/db/prisma";
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

  // Lightweight existence/ownership check — the real state reconstruction (and its
  // expiry side effects) stays in ExamRunner's own client-side fetch; this just
  // makes a bad/foreign examId 404 immediately instead of silently falling through
  // to the client component's own error path.
  const exam = await prisma.exam.findFirst({ where: { id: examId, userId: user.id, courseId }, select: { id: true } });
  if (!exam) notFound();

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-10">
      <ExamRunner courseId={course.id} examId={examId} />
    </div>
  );
}
