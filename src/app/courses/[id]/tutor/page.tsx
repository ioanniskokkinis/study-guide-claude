import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse } from "@/lib/services/courses";
import { getCourseMastery } from "@/lib/services/student-knowledge";
import { TutorChat } from "@/components/tutor/TutorChat";
import { TUTOR_MODES, type TutorModeValue } from "@/lib/tutor/types";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ conceptId?: string; mode?: string }>;
}

function isTutorMode(value: string | undefined): value is TutorModeValue {
  return !!value && (TUTOR_MODES as readonly string[]).includes(value);
}

export default async function TutorPage({ params, searchParams }: PageProps) {
  const { id: courseId } = await params;
  const { conceptId, mode } = await searchParams;
  const user = await getCurrentUser();
  const course = await findOwnedCourse(user.id, courseId);
  if (!course) notFound();

  const mastery = await getCourseMastery(user.id, courseId);
  const concepts = mastery?.concepts ?? [];
  const selected = conceptId ? concepts.find((c) => c.conceptId === conceptId) : undefined;

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <Link href={`/courses/${course.id}`} className="text-sm text-zinc-500 hover:underline">
        ← {course.title}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">AI Tutor</h1>

      {concepts.length === 0 ? (
        <p className="mt-6 rounded-lg border border-zinc-200 p-6 text-sm text-zinc-500 dark:border-zinc-800">
          This course doesn&rsquo;t have a knowledge graph yet.{" "}
          <Link href={`/courses/${course.id}/knowledge`} className="underline underline-offset-2">
            Build it
          </Link>{" "}
          before you can start a tutoring conversation.
        </p>
      ) : !selected ? (
        <div className="mt-6">
          <p className="text-sm text-zinc-500">Which concept would you like to work through?</p>
          <ul className="mt-3 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {concepts
              .slice()
              .sort((a, b) => a.overallMastery - b.overallMastery)
              .map((c) => (
                <li key={c.conceptId}>
                  <Link
                    href={`/courses/${course.id}/tutor?conceptId=${c.conceptId}`}
                    className="flex items-center justify-between gap-4 px-4 py-3 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
                  >
                    <span className="font-medium text-zinc-900 dark:text-zinc-50">{c.conceptName}</span>
                    <span className="text-xs text-zinc-400">
                      {c.exposureCount > 0 ? `${Math.round(c.overallMastery * 100)}% mastery` : "not yet studied"}
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </div>
      ) : (
        <div className="mt-6">
          <TutorChat
            courseId={course.id}
            conceptId={selected.conceptId}
            conceptName={selected.conceptName}
            initialMastery={selected.overallMastery}
            mode={isTutorMode(mode) ? mode : "SOCRATIC"}
            ttsEnabled={env.TTS_ENABLED}
          />
        </div>
      )}
    </div>
  );
}
