import Link from "next/link";
import { bucketForStatus, type CourseMastery } from "@/lib/services/student-knowledge";
import { formatMasteryPercent, MASTERY_BUCKET_LABEL } from "./mastery-status-label";

const BUCKET_ORDER = ["strong", "developing", "weak", "unknown"] as const;

export function MyKnowledgeSummaryCard({ courseId, mastery }: { courseId: string; mastery: CourseMastery }) {
  const counts = { strong: 0, developing: 0, weak: 0, unknown: 0 };
  for (const concept of mastery.concepts) {
    counts[bucketForStatus(concept.status)] += 1;
  }

  const hasEvidence = mastery.concepts.some((c) => c.exposureCount > 0);

  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-500">My Knowledge</h2>
        <Link
          href={`/courses/${courseId}/knowledge`}
          className="text-xs font-medium text-zinc-500 underline-offset-2 hover:underline"
        >
          View details
        </Link>
      </div>

      {!hasEvidence ? (
        <p className="mt-3 text-sm text-zinc-500">
          No study activity yet — mastery data will appear here once you start answering questions.
        </p>
      ) : (
        <>
          <p className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            {formatMasteryPercent(mastery.overallMastery)}
            <span className="ml-2 text-sm font-normal text-zinc-500">overall mastery</span>
          </p>
          <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
            {BUCKET_ORDER.map((bucket) => (
              <div key={bucket}>
                <dt className={`text-xs font-medium ${MASTERY_BUCKET_LABEL[bucket].className}`}>
                  {MASTERY_BUCKET_LABEL[bucket].label}
                </dt>
                <dd className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{counts[bucket]}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </div>
  );
}
