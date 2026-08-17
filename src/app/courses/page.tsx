import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { listCourses } from "@/lib/services/courses";
import { NewCourseForm } from "@/components/courses/NewCourseForm";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

// Course list changes as users create/delete courses — always fetch fresh.
export const dynamic = "force-dynamic";

export default async function CoursesPage() {
  const user = await getCurrentUser();
  const courses = await listCourses(user.id);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Courses</h1>
      </div>

      <div className="mt-4">
        <NewCourseForm />
      </div>

      {courses.length === 0 ? (
        <div className="mt-8">
          <EmptyState icon="🎒" title="No courses yet" description="Create one to get started." />
        </div>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2">
          {courses.map((course) => (
            <li key={course.id}>
              <Link href={`/courses/${course.id}`}>
                <Card interactive>
                  <h2 className="font-medium text-fg">{course.title}</h2>
                  <p className="mt-1 text-sm text-fg-muted">
                    {course._count.documents} document
                    {course._count.documents === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-fg-subtle">
                    Created{" "}
                    {new Date(course.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </p>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
