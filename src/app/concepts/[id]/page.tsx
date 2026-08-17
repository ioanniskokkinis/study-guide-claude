import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getConceptDetail } from "@/lib/services/knowledge";
import {
  getConceptEvidence,
  getConceptMistakes,
  getMastery,
  getPrerequisiteStatus,
} from "@/lib/services/student-knowledge";
import { getReviewItemDetail } from "@/lib/review/review-queries";
import { ConceptMyKnowledge } from "@/components/knowledge/ConceptMyKnowledge";
import { PracticeConceptButton } from "@/components/knowledge/PracticeConceptButton";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { SectionHeader } from "@/components/ui/SectionHeader";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

interface RelationshipEntryProps {
  concept: { id: string; name: string };
  label?: string;
  confidence: number;
  evidence: string;
  needsReview: boolean;
}

function RelationshipEntry({ concept, label, confidence, evidence, needsReview }: RelationshipEntryProps) {
  return (
    <details className="group rounded-md border border-border p-3">
      <summary className="focus-ring flex cursor-pointer list-none items-center justify-between rounded text-sm font-medium text-fg">
        <span>
          {concept.name}
          {label && <span className="ml-2 text-xs font-normal text-fg-subtle">{label}</span>}
        </span>
        {needsReview && <Badge tone="warning">needs review</Badge>}
      </summary>
      <div className="mt-2 space-y-1 text-sm text-fg-muted">
        <p>Confidence: {(confidence * 100).toFixed(0)}%</p>
        <p className="italic">&ldquo;{evidence}&rdquo;</p>
        <Link href={`/concepts/${concept.id}`} className="focus-ring inline-block rounded underline underline-offset-2">
          View concept
        </Link>
      </div>
    </details>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-8">
      <SectionHeader title={title} />
      <div className="mt-2 space-y-2">{children}</div>
    </div>
  );
}

export default async function ConceptDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  const concept = await getConceptDetail(user.id, id);

  if (!concept) {
    notFound();
  }

  const [mastery, prerequisiteStatus, evidence, mistakes, reviewDetail] = await Promise.all([
    getMastery(user.id, id),
    getPrerequisiteStatus(user.id, id),
    getConceptEvidence(user.id, id),
    getConceptMistakes(user.id, id),
    getReviewItemDetail(user.id, id),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <Link href={`/courses/${concept.course.id}/knowledge`} className="focus-ring text-sm text-fg-muted hover:text-fg hover:underline">
        ← {concept.course.title} knowledge graph
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">{concept.name}</h1>

      <div className="mt-3 flex flex-wrap gap-2">
        <Link href={`/courses/${concept.course.id}/study`}>
          <Button variant="secondary">Study</Button>
        </Link>
        <PracticeConceptButton courseId={concept.course.id} conceptId={concept.id} />
        <Link href={`/courses/${concept.course.id}/tutor?conceptId=${concept.id}`}>
          <Button variant="secondary">Ask Tutor</Button>
        </Link>
      </div>

      {mastery && (
        <ConceptMyKnowledge
          courseId={concept.course.id}
          mastery={mastery}
          prerequisiteStatus={prerequisiteStatus}
          evidence={evidence ?? []}
          mistakes={mistakes ?? []}
          reviewDetail={reviewDetail}
        />
      )}

      <h2 className="mt-10 text-sm font-semibold text-fg">Course Knowledge</h2>
      <p className="mt-1 text-sm text-fg-muted">Difficulty {concept.difficulty}/5</p>
      {concept.description && <p className="mt-3 text-fg">{concept.description}</p>}

      <Section title={`Prerequisites (${concept.prerequisites.length})`}>
        {concept.prerequisites.length === 0 ? (
          <p className="text-sm text-fg-muted">None identified.</p>
        ) : (
          concept.prerequisites.map((entry, index) => (
            <RelationshipEntry key={`${entry.concept.id}-${index}`} {...entry} />
          ))
        )}
      </Section>

      <Section title={`Used by (${concept.usedBy.length})`}>
        {concept.usedBy.length === 0 ? (
          <p className="text-sm text-fg-muted">No concepts depend on this one yet.</p>
        ) : (
          concept.usedBy.map((entry, index) => (
            <RelationshipEntry key={`${entry.concept.id}-${index}`} {...entry} />
          ))
        )}
      </Section>

      <Section title={`Related concepts (${concept.related.length})`}>
        {concept.related.length === 0 ? (
          <p className="text-sm text-fg-muted">None identified.</p>
        ) : (
          concept.related.map((entry, index) => (
            <RelationshipEntry
              key={`${entry.concept.id}-${index}`}
              concept={entry.concept}
              label={entry.direction === "outgoing" ? entry.relationshipType : `← ${entry.relationshipType}`}
              confidence={entry.confidence}
              evidence={entry.evidence}
              needsReview={entry.needsReview}
            />
          ))
        )}
      </Section>

      <Section title={`Sources (${concept.sources.length})`}>
        {concept.sources.length === 0 ? (
          <p className="text-sm text-fg-muted">No sources recorded.</p>
        ) : (
          concept.sources.map((source) => (
            <div key={source.id} className="rounded-md border border-border p-3 text-sm">
              <p className="font-medium text-fg">
                {source.documentName} · chunk {source.chunkIndex}
              </p>
              <p className="mt-1 italic text-fg-muted">&ldquo;{source.evidence}&rdquo;</p>
            </div>
          ))
        )}
      </Section>
    </div>
  );
}
