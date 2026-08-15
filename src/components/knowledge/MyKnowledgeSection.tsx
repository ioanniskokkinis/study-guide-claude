import Link from "next/link";
import type { KnowledgeSnapshot, MistakeSummary } from "@/lib/services/student-knowledge";
import { MistakeResolveButton } from "./MistakeResolveButton";
import { formatMasteryPercent, masteryStatusLabel } from "./mastery-status-label";

function ConceptBucketColumn({
  title,
  concepts,
  emptyLabel,
}: {
  title: string;
  concepts: KnowledgeSnapshot["strongConcepts"];
  emptyLabel: string;
}) {
  return (
    <div>
      <h3 className="text-xs font-medium text-zinc-500">
        {title} ({concepts.length})
      </h3>
      {concepts.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-400">{emptyLabel}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {concepts.map((c) => (
            <li key={c.conceptId} className="flex items-center justify-between gap-2 text-sm">
              <Link
                href={`/concepts/${c.conceptId}`}
                className="truncate text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-50"
              >
                {c.conceptName}
              </Link>
              <span className="shrink-0 text-zinc-500">{formatMasteryPercent(c.overallMastery)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MistakeRow({ mistake }: { mistake: MistakeSummary }) {
  return (
    <li className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`/concepts/${mistake.conceptId}`}
            className="font-medium text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-50"
          >
            {mistake.conceptName}
          </Link>
          <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs text-zinc-500 dark:border-zinc-700">
            {mistake.category.replaceAll("_", " ").toLowerCase()}
          </span>
          <span className="text-xs text-zinc-400">{mistake.severity.toLowerCase()}</span>
        </div>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{mistake.description}</p>
      </div>
      <div className="shrink-0 text-right">
        {mistake.resolved ? (
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Reviewed</span>
        ) : (
          <MistakeResolveButton mistakeId={mistake.id} />
        )}
      </div>
    </li>
  );
}

export function MyKnowledgeSection({
  snapshot,
  developingConcepts,
  mistakes,
}: {
  snapshot: KnowledgeSnapshot;
  developingConcepts: KnowledgeSnapshot["strongConcepts"];
  mistakes: MistakeSummary[];
}) {
  const totalTracked =
    snapshot.strongConcepts.length + developingConcepts.length + snapshot.weakConcepts.length;

  return (
    <div className="mt-10">
      <h2 className="text-sm font-medium text-zinc-500">My Knowledge</h2>

      {totalTracked === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">
          No study activity yet — mastery data will appear here once you start answering questions.
        </p>
      ) : (
        <p className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          {formatMasteryPercent(snapshot.overallMastery)}
          <span className="ml-2 text-sm font-normal text-zinc-500">overall mastery</span>
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <ConceptBucketColumn title="Strong" concepts={snapshot.strongConcepts} emptyLabel="None yet." />
        <ConceptBucketColumn title="Developing" concepts={developingConcepts} emptyLabel="None yet." />
        <ConceptBucketColumn title="Weak" concepts={snapshot.weakConcepts} emptyLabel="None yet." />
        <ConceptBucketColumn title="Unknown" concepts={snapshot.unknownConcepts} emptyLabel="None." />
      </div>

      {snapshot.prerequisiteGaps.length > 0 && (
        <div className="mt-6 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
          <p className="font-medium text-amber-800 dark:text-amber-300">Remediation candidates</p>
          <ul className="mt-1 space-y-1 text-amber-700 dark:text-amber-400">
            {snapshot.prerequisiteGaps.map((gap) => (
              <li key={`${gap.prerequisite.conceptId}-${gap.concept.conceptId}`}>
                <Link href={`/concepts/${gap.prerequisite.conceptId}`} className="underline underline-offset-2">
                  {gap.prerequisite.conceptName}
                </Link>{" "}
                is weak and is a prerequisite of{" "}
                <Link href={`/concepts/${gap.concept.conceptId}`} className="underline underline-offset-2">
                  {gap.concept.conceptName}
                </Link>{" "}
                (also weak) — likely worth reviewing first.
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3 className="mt-8 text-sm font-medium text-zinc-500">Mistakes to review ({mistakes.length})</h3>
      {mistakes.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">No mistakes recorded yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {mistakes.map((mistake) => (
            <MistakeRow key={mistake.id} mistake={mistake} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Re-exported for callers that just need the friendly status text (spec §32). */
export { masteryStatusLabel };
