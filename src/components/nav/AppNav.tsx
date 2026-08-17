"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

/**
 * The persistent top-level nav (Phase 10, redesigned Phase 18.2). Contextual:
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
  { suffix: "/advisor", label: "Advisor" },
];

function isTabActive(suffix: string, rest: string): boolean {
  if (suffix === "") return rest === "" || rest.startsWith("/documents") || rest.startsWith("/knowledge");
  return rest === suffix || rest.startsWith(`${suffix}/`);
}

function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-sm font-semibold text-accent-fg"
    >
      A
    </span>
  );
}

export function AppNav() {
  const pathname = usePathname();
  const match = pathname.match(/^\/courses\/([^/]+)(\/.*)?$/);
  const courseId = match?.[1];
  const rest = match?.[2] ?? "";

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href="/courses" className="focus-ring flex items-center gap-2 rounded-md">
          <BrandMark />
          <span className="text-sm font-semibold tracking-tight text-fg">AI Study Coach</span>
        </Link>

        <div className="flex items-center gap-1">
          <Link
            href="/courses"
            className="focus-ring transition-standard rounded-md px-3 py-1.5 text-sm font-medium text-fg-muted hover:bg-surface-hover hover:text-fg"
          >
            Courses
          </Link>
          <ThemeToggle />
        </div>
      </div>

      {courseId && (
        <nav
          className="scrollbar-none mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 pb-0 sm:px-6"
          aria-label="Course sections"
        >
          {COURSE_TABS.map((tab) => {
            const active = isTabActive(tab.suffix, rest);
            return (
              <Link
                key={tab.suffix}
                href={`/courses/${courseId}${tab.suffix}`}
                aria-current={active ? "page" : undefined}
                className={`focus-ring transition-standard relative shrink-0 px-3 py-2.5 text-sm font-medium whitespace-nowrap ${
                  active ? "text-fg" : "text-fg-muted hover:text-fg"
                }`}
              >
                {tab.label}
                <span
                  aria-hidden="true"
                  className={`absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-standard ${
                    active ? "bg-accent" : "bg-transparent"
                  }`}
                />
              </Link>
            );
          })}
        </nav>
      )}
    </header>
  );
}
