import Link from "next/link";
import type { KnowledgeSnapshot, MistakeSummary } from "@/lib/services/student-knowledge";
import { Card } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Badge } from "@/components/ui/Badge";
import { MistakeResolveButton } from "./MistakeResolveButton";
import { formatMasteryPercent, masteryStatusLabel, MASTERY_BUCKET_TONE } from "./mastery-status-label";

function ConceptBucketColumn({
  title,
  concepts,
  emptyLabel,
  tone,
}: {
  title: string;
  concepts: KnowledgeSnapshot["strongConcepts"];
  emptyLabel: string;
  tone: "success" | "warning" | "danger" | "neutral";
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-fg-muted">{title}</h3>
        <Badge tone={tone}>{concepts.length}</Badge>
      </div>
      {concepts.length === 0 ? (
        <p className="mt-2 text-sm text-fg-subtle">{emptyLabel}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {concepts.map((c) => (
            <li key={c.conceptId} className="flex items-center justify-between gap-2 text-sm">
              <Link href={`/concepts/${c.conceptId}`} className="focus-ring truncate rounded text-fg hover:underline">
                {c.conceptName}
              </Link>
              <span className="shrink-0 text-fg-muted">{formatMasteryPercent(c.overallMastery)}</span>
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
          <Link href={`/concepts/${mistake.conceptId}`} className="focus-ring truncate rounded font-medium text-fg hover:underline">
            {mistake.conceptName}
          </Link>
          <Badge>{mistake.category.replaceAll("_", " ").toLowerCase()}</Badge>
          <span className="text-xs text-fg-subtle">{mistake.severity.toLowerCase()}</span>
        </div>
        <p className="mt-1 text-sm text-fg-muted">{mistake.description}</p>
      </div>
      <div className="shrink-0 text-right">
        {mistake.resolved ? <Badge tone="success">Reviewed</Badge> : <MistakeResolveButton mistakeId={mistake.id} />}
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
      <SectionHeader title="My Knowledge" />

      {totalTracked === 0 ? (
        <p className="mt-2 text-sm text-fg-muted">
          No study activity yet — mastery data will appear here once you start answering questions.
        </p>
      ) : (
        <p className="mt-1 text-2xl font-semibold text-fg">
          {formatMasteryPercent(snapshot.overallMastery)}
          <span className="ml-2 text-sm font-normal text-fg-muted">overall mastery</span>
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <ConceptBucketColumn title="Strong" concepts={snapshot.strongConcepts} emptyLabel="None yet." tone={MASTERY_BUCKET_TONE.strong} />
        <ConceptBucketColumn title="Developing" concepts={developingConcepts} emptyLabel="None yet." tone={MASTERY_BUCKET_TONE.developing} />
        <ConceptBucketColumn title="Weak" concepts={snapshot.weakConcepts} emptyLabel="None yet." tone={MASTERY_BUCKET_TONE.weak} />
        <ConceptBucketColumn title="Unknown" concepts={snapshot.unknownConcepts} emptyLabel="None." tone={MASTERY_BUCKET_TONE.unknown} />
      </div>

      {snapshot.prerequisiteGaps.length > 0 && (
        <Card className="mt-6 border-warning-border bg-warning-bg">
          <p className="text-sm font-medium text-warning-fg">Remediation candidates</p>
          <ul className="mt-1 space-y-1 text-sm text-warning-fg/90">
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
        </Card>
      )}

      <h3 className="mt-8 text-sm font-medium text-fg-muted">Mistakes to review ({mistakes.length})</h3>
      {mistakes.length === 0 ? (
        <p className="mt-2 text-sm text-fg-muted">No mistakes recorded yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
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
