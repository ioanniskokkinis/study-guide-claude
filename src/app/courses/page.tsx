import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { listCourses } from "@/lib/services/courses";
import { NewCourseForm } from "@/components/courses/NewCourseForm";

// Course list changes as users create/delete courses — always fetch fresh.
export const dynamic = "force-dynamic";

export default async function CoursesPage() {
  const user = await getCurrentUser();
  const courses = await listCourses(user.id);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Courses
        </h1>
      </div>

      <div className="mt-4">
        <NewCourseForm />
      </div>

      {courses.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">
          No courses yet. Create one to get started.
        </p>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2">
          {courses.map((course) => (
            <li
              key={course.id}
              className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
            >
              <h2 className="font-medium text-zinc-900 dark:text-zinc-50">
                {course.title}
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                {course._count.documents} document
                {course._count.documents === 1 ? "" : "s"}
              </p>
              <p className="text-xs text-zinc-400">
                Created{" "}
                {new Date(course.createdAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </p>
              <Link
                href={`/courses/${course.id}`}
                className="mt-3 inline-block text-sm font-medium underline underline-offset-2"
              >
                Open course
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
