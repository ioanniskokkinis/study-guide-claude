import type { ConceptMasterySummary, EvidenceSummary, MistakeSummary, PrerequisiteStatusNode } from "@/lib/services/student-knowledge";
import type { ReviewItemDetail } from "@/lib/review/review-queries";
import { formatRelativeDays } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { MistakeResolveButton } from "./MistakeResolveButton";
import { PracticeConceptButton } from "./PracticeConceptButton";
import { formatMasteryPercent, masteryStatusLabel, masteryStatusTone } from "./mastery-status-label";

function DimensionBar({ label, score }: { label: string; score: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-fg-muted">
        <span>{label}</span>
        <span>{formatMasteryPercent(score)}</span>
      </div>
      <div className="mt-1">
        <ProgressBar value={score} />
      </div>
    </div>
  );
}

export function ConceptMyKnowledge({
  courseId,
  mastery,
  prerequisiteStatus,
  evidence,
  mistakes,
  reviewDetail,
}: {
  courseId: string;
  mastery: ConceptMasterySummary;
  prerequisiteStatus: PrerequisiteStatusNode | null;
  evidence: EvidenceSummary[];
  mistakes: MistakeSummary[];
  reviewDetail?: ReviewItemDetail | null;
}) {
  const status = masteryStatusLabel(mastery.status);
  const accuracy = mastery.attemptCount > 0 ? mastery.successCount / mastery.attemptCount : null;
  const weakerPrerequisite = prerequisiteStatus
    ? [...prerequisiteStatus.prerequisites]
        .filter((p) => p.mastery.overallMastery < mastery.overallMastery)
        .sort((a, b) => a.mastery.overallMastery - b.mastery.overallMastery)[0]
    : undefined;

  return (
    <Card className="mt-8 border-2 border-dashed">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">My Knowledge</h2>
        <Badge tone={masteryStatusTone(mastery.status)}>{status.label}</Badge>
      </div>

      {mastery.exposureCount === 0 ? (
        <p className="mt-2 text-sm text-fg-muted">
          Not enough evidence yet — this will fill in once you attempt questions on this concept.
        </p>
      ) : (
        <>
          <p className="mt-1 text-xl font-semibold text-fg">
            {formatMasteryPercent(mastery.overallMastery)}
            <span className="ml-2 text-sm font-normal text-fg-muted">overall mastery</span>
          </p>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <DimensionBar label="Recall" score={mastery.recallScore} />
            <DimensionBar label="Explanation" score={mastery.explanationScore} />
            <DimensionBar label="Application" score={mastery.applicationScore} />
            <DimensionBar label="Transfer" score={mastery.transferScore} />
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            <div>
              <dt className="text-xs text-fg-subtle">Confidence</dt>
              <dd className="text-fg">{formatMasteryPercent(mastery.confidenceScore)}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-subtle">Accuracy</dt>
              <dd className="text-fg">{accuracy == null ? "—" : formatMasteryPercent(accuracy)}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-subtle">Attempts</dt>
              <dd className="text-fg">{mastery.attemptCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-subtle">Successes</dt>
              <dd className="text-fg">{mastery.successCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-subtle">Failures</dt>
              <dd className="text-fg">{mastery.failureCount}</dd>
            </div>
          </dl>
        </>
      )}

      {reviewDetail && (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-fg-muted">Spaced review</h3>
          <dl className="mt-1 grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs text-fg-subtle">Reviews</dt>
              <dd className="text-fg">{reviewDetail.reviewCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-subtle">Last review</dt>
              <dd className="text-fg">{reviewDetail.item.lastReviewedAt ? formatRelativeDays(reviewDetail.item.lastReviewedAt) : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-subtle">Next review</dt>
              <dd className="text-fg">{formatRelativeDays(reviewDetail.item.nextReviewAt)}</dd>
            </div>
          </dl>
        </div>
      )}

      {prerequisiteStatus && prerequisiteStatus.prerequisites.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-fg-muted">Prerequisite status</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {prerequisiteStatus.prerequisites.map((p) => {
              const prereqStatus = masteryStatusLabel(p.mastery.status);
              return (
                <li key={p.concept.id} className="flex items-center justify-between">
                  <span className="text-fg">{p.concept.name}</span>
                  <Badge tone={masteryStatusTone(p.mastery.status)}>
                    {prereqStatus.label} · {formatMasteryPercent(p.mastery.overallMastery)}
                  </Badge>
                </li>
              );
            })}
          </ul>
          {weakerPrerequisite && (
            <Card padding="sm" className="mt-3 border-warning-border bg-warning-bg">
              <p className="text-sm font-medium text-warning-fg">Recommended prerequisite</p>
              <p className="mt-1 text-sm text-warning-fg/90">
                {weakerPrerequisite.concept.name} — {formatMasteryPercent(weakerPrerequisite.mastery.overallMastery)} mastery, lower than this
                concept&rsquo;s.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <a
                  href={`/concepts/${weakerPrerequisite.concept.id}`}
                  className="focus-ring inline-block rounded-md border border-warning-border px-3 py-1 text-xs font-medium text-warning-fg hover:bg-warning-bg"
                >
                  Review prerequisite
                </a>
                {/* Never hard-blocking (Phase 2 §F): practicing this concept directly is always available too. */}
                <PracticeConceptButton courseId={courseId} conceptId={mastery.conceptId} label="Practice anyway" />
              </div>
            </Card>
          )}
        </div>
      )}

      {mistakes.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-fg-muted">Mistakes ({mistakes.length})</h3>
          <ul className="mt-1 space-y-2">
            {mistakes.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-3 text-sm">
                <div>
                  <Badge>{m.category.replaceAll("_", " ").toLowerCase()}</Badge>
                  <p className="mt-1 text-fg-muted">{m.description}</p>
                </div>
                {m.resolved ? <Badge tone="success">Reviewed</Badge> : <MistakeResolveButton mistakeId={m.id} />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {evidence.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-fg-muted">Recent evidence</h3>
          <ul className="mt-1 space-y-1 text-sm text-fg-muted">
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
    </Card>
  );
}
