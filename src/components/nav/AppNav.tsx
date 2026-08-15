"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The persistent top-level nav (Phase 10 polish) — previously there was no
 * way to move between a course's Study/Tutor/Exam/Review/Progress sections
 * except by navigating back to the course detail page first. Contextual:
 * the course sub-nav only appears while inside `/courses/:id/...`, derived
 * entirely from the current pathname (no props, no extra data fetch) so it
 * works identically from every course page without each one wiring it up.
 */

const COURSE_TABS: Array<{ suffix: string; label: string }> = [
  { suffix: "", label: "Overview" },
  { suffix: "/study", label: "Study" },
  { suffix: "/tutor", label: "Tutor" },
  { suffix: "/exam", label: "Exam" },
  { suffix: "/review", label: "Review" },
  { suffix: "/progress", label: "Progress" },
];

function isTabActive(suffix: string, rest: string): boolean {
  if (suffix === "") return rest === "" || rest.startsWith("/documents") || rest.startsWith("/knowledge");
  return rest === suffix || rest.startsWith(`${suffix}/`);
}

export function AppNav() {
  const pathname = usePathname();
  const match = pathname.match(/^\/courses\/([^/]+)(\/.*)?$/);
  const courseId = match?.[1];
  const rest = match?.[2] ?? "";

  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <Link href="/courses" className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          AI Study Coach
        </Link>
        <Link href="/courses" className="text-sm text-zinc-500 hover:underline">
          Courses
        </Link>
      </div>

      {courseId && (
        <nav className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-6 pb-2" aria-label="Course sections">
          {COURSE_TABS.map((tab) => {
            const active = isTabActive(tab.suffix, rest);
            return (
              <Link
                key={tab.suffix}
                href={`/courses/${courseId}${tab.suffix}`}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900"
                    : "rounded-md px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"
                }
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      )}
    </header>
  );
}
