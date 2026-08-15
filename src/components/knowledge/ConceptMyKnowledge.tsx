import type { ConceptMasterySummary, EvidenceSummary, MistakeSummary, PrerequisiteStatusNode } from "@/lib/services/student-knowledge";
import type { ReviewItemDetail } from "@/lib/review/review-queries";
import { formatRelativeDays } from "@/lib/format";
import { MistakeResolveButton } from "./MistakeResolveButton";
import { formatMasteryPercent, masteryStatusLabel } from "./mastery-status-label";

function DimensionBar({ label, score }: { label: string; score: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>{label}</span>
        <span>{formatMasteryPercent(score)}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className="h-1.5 rounded-full bg-zinc-900 dark:bg-zinc-50"
          style={{ width: `${Math.round(score * 100)}%` }}
        />
      </div>
    </div>
  );
}

export function ConceptMyKnowledge({
  mastery,
  prerequisiteStatus,
  evidence,
  mistakes,
  reviewDetail,
}: {
  mastery: ConceptMasterySummary;
  prerequisiteStatus: PrerequisiteStatusNode | null;
  evidence: EvidenceSummary[];
  mistakes: MistakeSummary[];
  reviewDetail?: ReviewItemDetail | null;
}) {
  const status = masteryStatusLabel(mastery.status);
  const accuracy = mastery.attemptCount > 0 ? mastery.successCount / mastery.attemptCount : null;

  return (
    <div className="mt-8 rounded-lg border-2 border-dashed border-zinc-300 p-4 dark:border-zinc-700">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">My Knowledge</h2>
        <span className={`text-sm font-medium ${status.className}`}>{status.label}</span>
      </div>

      {mastery.exposureCount === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">
          Not enough evidence yet — this will fill in once you attempt questions on this concept.
        </p>
      ) : (
        <>
          <p className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
            {formatMasteryPercent(mastery.overallMastery)}
            <span className="ml-2 text-sm font-normal text-zinc-500">overall mastery</span>
          </p>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <DimensionBar label="Recall" score={mastery.recallScore} />
            <DimensionBar label="Explanation" score={mastery.explanationScore} />
            <DimensionBar label="Application" score={mastery.applicationScore} />
            <DimensionBar label="Transfer" score={mastery.transferScore} />
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            <div>
              <dt className="text-xs text-zinc-400">Confidence</dt>
              <dd className="text-zinc-900 dark:text-zinc-50">{formatMasteryPercent(mastery.confidenceScore)}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400">Accuracy</dt>
              <dd className="text-zinc-900 dark:text-zinc-50">{accuracy == null ? "—" : formatMasteryPercent(accuracy)}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400">Attempts</dt>
              <dd className="text-zinc-900 dark:text-zinc-50">{mastery.attemptCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400">Successes</dt>
              <dd className="text-zinc-900 dark:text-zinc-50">{mastery.successCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400">Failures</dt>
              <dd className="text-zinc-900 dark:text-zinc-50">{mastery.failureCount}</dd>
            </div>
          </dl>
        </>
      )}

      {reviewDetail && (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-zinc-500">Spaced review</h3>
          <dl className="mt-1 grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs text-zinc-400">Reviews</dt>
              <dd className="text-zinc-900 dark:text-zinc-50">{reviewDetail.reviewCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400">Last review</dt>
              <dd className="text-zinc-900 dark:text-zinc-50">
                {reviewDetail.item.lastReviewedAt ? formatRelativeDays(reviewDetail.item.lastReviewedAt) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400">Next review</dt>
              <dd className="text-zinc-900 dark:text-zinc-50">{formatRelativeDays(reviewDetail.item.nextReviewAt)}</dd>
            </div>
          </dl>
        </div>
      )}

      {prerequisiteStatus && prerequisiteStatus.prerequisites.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-zinc-500">Prerequisite status</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {prerequisiteStatus.prerequisites.map((p) => {
              const prereqStatus = masteryStatusLabel(p.mastery.status);
              return (
                <li key={p.concept.id} className="flex items-center justify-between">
                  <span className="text-zinc-700 dark:text-zinc-300">{p.concept.name}</span>
                  <span className={`text-xs font-medium ${prereqStatus.className}`}>
                    {prereqStatus.label} · {formatMasteryPercent(p.mastery.overallMastery)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {mistakes.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-zinc-500">Mistakes ({mistakes.length})</h3>
          <ul className="mt-1 space-y-2">
            {mistakes.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-3 text-sm">
                <div>
                  <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs text-zinc-500 dark:border-zinc-700">
                    {m.category.replaceAll("_", " ").toLowerCase()}
                  </span>
                  <p className="mt-1 text-zinc-600 dark:text-zinc-400">{m.description}</p>
                </div>
                {m.resolved ? (
                  <span className="shrink-0 text-xs font-medium text-emerald-600 dark:text-emerald-400">Reviewed</span>
                ) : (
                  <div className="shrink-0">
                    <MistakeResolveButton mistakeId={m.id} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {evidence.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-zinc-500">Recent evidence</h3>
          <ul className="mt-1 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
            {evidence.slice(0, 10).map((e) => (
              <li key={e.id} className="flex items-center justify-between">
                <span>{e.outcome.charAt(0) + e.outcome.slice(1).toLowerCase()}</span>
                <span>
                  {formatMasteryPercent(e.score)} · {new Date(e.createdAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
