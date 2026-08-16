import Link from "next/link";
import { bucketForStatus, type CourseMastery } from "@/lib/services/student-knowledge";
import type { RankedWeakConcept } from "@/lib/learning/weak-concepts";
import type { NextLearningAction } from "@/lib/learning/adaptive-engine";
import { PracticeConceptButton } from "./PracticeConceptButton";
import { formatMasteryPercent, MASTERY_BUCKET_LABEL } from "./mastery-status-label";

const BUCKET_ORDER = ["strong", "developing", "weak", "unknown"] as const;
const WEAK_CONCEPTS_SHOWN = 3;

/**
 * The personalized "Your Learning" section (Phase 2 §P) — everything here
 * is read straight from existing services (getCourseMastery,
 * getReviewState, rankWeakConcepts, getNextLearningAction) by the course
 * page's server component; this card only presents it. Every action link
 * goes to an already-functional destination (Study already runs the
 * adaptive engine; Review already runs the spaced-repetition queue;
 * Practice already opens the existing quiz cache/resume flow) — nothing
 * here is a placeholder.
 */
export function MyKnowledgeSummaryCard({
  courseId,
  mastery,
  dueCount,
  weakConcepts,
  recommendedAction,
}: {
  courseId: string;
  mastery: CourseMastery;
  dueCount?: number;
  weakConcepts?: RankedWeakConcept[];
  recommendedAction?: NextLearningAction | null;
}) {
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

          {recommendedAction && (
            <div className="mt-4 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
              <p className="text-xs font-medium text-zinc-400">Recommended next step</p>
              <p className="mt-1 text-zinc-700 dark:text-zinc-300">
                {recommendedAction.conceptName} — {recommendedAction.reason.message}
              </p>
              <Link
                href={`/courses/${courseId}/study`}
                className="mt-2 inline-block rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Start studying
              </Link>
            </div>
          )}

          {!!dueCount && dueCount > 0 && (
            <div className="mt-3 flex items-center justify-between rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
              <span className="text-zinc-700 dark:text-zinc-300">{dueCount} concept{dueCount === 1 ? "" : "s"} due for review</span>
              <Link
                href={`/courses/${courseId}/review`}
                className="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
              >
                Start Review
              </Link>
            </div>
          )}

          {weakConcepts && weakConcepts.length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs font-medium text-zinc-400">Weakest concepts</h3>
              <ul className="mt-1 space-y-2">
                {weakConcepts.slice(0, WEAK_CONCEPTS_SHOWN).map((c) => (
                  <li key={c.conceptId} className="flex items-center justify-between gap-3 text-sm">
                    <Link href={`/concepts/${c.conceptId}`} className="text-zinc-700 underline-offset-2 hover:underline dark:text-zinc-300">
                      {c.conceptName}
                    </Link>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-zinc-400">{formatMasteryPercent(c.mastery.overallMastery)}</span>
                      <PracticeConceptButton courseId={courseId} conceptId={c.conceptId} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
