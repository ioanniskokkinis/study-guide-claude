import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { findOwnedCourse } from "@/lib/services/courses";
import { getCourseMastery } from "@/lib/services/student-knowledge";
import { TutorChat } from "@/components/tutor/TutorChat";
import { TUTOR_MODES, type TutorModeValue } from "@/lib/tutor/types";
import { env } from "@/lib/env";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";

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
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-10">
      <Link href={`/courses/${course.id}`} className="focus-ring text-sm text-fg-muted hover:text-fg hover:underline">
        ← {course.title}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">AI Tutor</h1>

      {concepts.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon="🎓"
            title="No knowledge graph yet"
            description="Build the knowledge graph before you can start a tutoring conversation."
            action={
              <Link href={`/courses/${course.id}/knowledge`} className="focus-ring rounded text-sm text-fg underline underline-offset-2">
                Build it →
              </Link>
            }
          />
        </div>
      ) : !selected ? (
        <div className="mt-6">
          <p className="text-sm text-fg-muted">Which concept would you like to work through?</p>
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
            {concepts
              .slice()
              .sort((a, b) => a.overallMastery - b.overallMastery)
              .map((c) => (
                <li key={c.conceptId}>
                  <Link
                    href={`/courses/${course.id}/tutor?conceptId=${c.conceptId}`}
                    className="focus-ring transition-standard flex items-center justify-between gap-4 px-4 py-3 text-sm hover:bg-surface-hover"
                  >
                    <span className="font-medium text-fg">{c.conceptName}</span>
                    {c.exposureCount > 0 ? <Badge>{Math.round(c.overallMastery * 100)}% mastery</Badge> : <Badge tone="neutral">not yet studied</Badge>}
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
