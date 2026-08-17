import Link from "next/link";
import { bucketForStatus, type CourseMastery } from "@/lib/services/student-knowledge";
import type { RankedWeakConcept } from "@/lib/learning/weak-concepts";
import type { NextLearningAction } from "@/lib/learning/adaptive-engine";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ProgressRing } from "@/components/ui/ProgressRing";
import { EmptyState } from "@/components/ui/EmptyState";
import { PracticeConceptButton } from "./PracticeConceptButton";
import { formatMasteryPercent, MASTERY_BUCKET_LABEL, MASTERY_BUCKET_TONE } from "./mastery-status-label";

const BUCKET_ORDER = ["strong", "developing", "weak", "unknown"] as const;
const WEAK_CONCEPTS_SHOWN = 3;

/**
 * The personalized "Your Learning" section (Phase 2 §P, redesigned Phase
 * 18.4 around Course -> Current state -> Recommended action -> Learning
 * areas). Everything here is read straight from existing services
 * (getCourseMastery, getReviewState, rankWeakConcepts,
 * getNextLearningAction) by the course page's server component; this only
 * presents it. Every action link goes to an already-functional destination
 * — nothing here is a placeholder.
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

  if (!hasEvidence) {
    return (
      <EmptyState
        icon="📘"
        title="No study activity yet"
        description="Mastery data will appear here once you start answering questions."
        action={
          <Link href={`/courses/${courseId}/study`}>
            <Button variant="primary">Start studying</Button>
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Current state */}
      <Card>
        <div className="flex flex-wrap items-center gap-6">
          <ProgressRing value={mastery.overallMastery} size={84} strokeWidth={7} label="Overall mastery" />
          <div className="flex flex-1 flex-wrap gap-x-6 gap-y-2">
            {BUCKET_ORDER.map((bucket) => (
              <div key={bucket}>
                <p className="text-xs font-medium text-fg-muted">{MASTERY_BUCKET_LABEL[bucket].label}</p>
                <p className="mt-0.5 text-lg font-semibold text-fg">{counts[bucket]}</p>
              </div>
            ))}
            {!!dueCount && dueCount > 0 && (
              <div>
                <p className="text-xs font-medium text-fg-muted">Due for review</p>
                <p className="mt-0.5 text-lg font-semibold text-warning">{dueCount}</p>
              </div>
            )}
          </div>
          <Link href={`/courses/${courseId}/knowledge`} className="focus-ring self-start rounded-md text-xs font-medium text-fg-muted hover:text-fg hover:underline">
            View knowledge graph →
          </Link>
        </div>
      </Card>

      {/* Recommended action — the dominant "what should I do right now" card */}
      {recommendedAction && (
        <Card className="border-accent/20 bg-surface-muted">
          <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">Recommended next step</p>
          <p className="mt-1.5 text-base font-medium text-fg">{recommendedAction.conceptName}</p>
          <p className="mt-0.5 text-sm text-fg-muted">{recommendedAction.reason.message}</p>
          <Link href={`/courses/${courseId}/study`} className="mt-3 inline-block">
            <Button variant="primary">Start studying</Button>
          </Link>
        </Card>
      )}

      {!!dueCount && dueCount > 0 && (
        <Card className="flex items-center justify-between gap-3">
          <p className="text-sm text-fg">
            <span className="font-medium">{dueCount}</span> concept{dueCount === 1 ? "" : "s"} due for review
          </p>
          <Link href={`/courses/${courseId}/review`}>
            <Button variant="secondary" size="sm">
              Start Review
            </Button>
          </Link>
        </Card>
      )}

      {/* Learning areas */}
      {weakConcepts && weakConcepts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Weakest concepts</CardTitle>
          </CardHeader>
          <ul className="space-y-3">
            {weakConcepts.slice(0, WEAK_CONCEPTS_SHOWN).map((c) => (
              <li key={c.conceptId} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/concepts/${c.conceptId}`} className="focus-ring truncate text-sm font-medium text-fg hover:underline">
                    {c.conceptName}
                  </Link>
                  <div className="mt-1">
                    <Badge tone={MASTERY_BUCKET_TONE.weak}>{formatMasteryPercent(c.mastery.overallMastery)}</Badge>
                  </div>
                </div>
                <PracticeConceptButton courseId={courseId} conceptId={c.conceptId} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
