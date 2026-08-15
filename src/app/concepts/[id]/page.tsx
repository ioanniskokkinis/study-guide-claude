import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getConceptDetail } from "@/lib/services/knowledge";

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
    <details className="group rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-zinc-900 dark:text-zinc-50">
        <span>
          {concept.name}
          {label && <span className="ml-2 text-xs font-normal text-zinc-400">{label}</span>}
        </span>
        {needsReview && (
          <span className="text-xs font-normal text-amber-600 dark:text-amber-400">needs review</span>
        )}
      </summary>
      <div className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
        <p>Confidence: {(confidence * 100).toFixed(0)}%</p>
        <p className="italic">&ldquo;{evidence}&rdquo;</p>
        <Link href={`/concepts/${concept.id}`} className="inline-block underline underline-offset-2">
          View concept
        </Link>
      </div>
    </details>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-8">
      <h2 className="text-sm font-medium text-zinc-500">{title}</h2>
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

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Link href={`/courses/${concept.course.id}/knowledge`} className="text-sm text-zinc-500 hover:underline">
        ← {concept.course.title} knowledge graph
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        {concept.name}
      </h1>
      <p className="mt-1 text-sm text-zinc-500">Difficulty {concept.difficulty}/5</p>
      {concept.description && <p className="mt-3 text-zinc-700 dark:text-zinc-300">{concept.description}</p>}

      <Section title={`Prerequisites (${concept.prerequisites.length})`}>
        {concept.prerequisites.length === 0 ? (
          <p className="text-sm text-zinc-500">None identified.</p>
        ) : (
          concept.prerequisites.map((entry, index) => (
            <RelationshipEntry key={`${entry.concept.id}-${index}`} {...entry} />
          ))
        )}
      </Section>

      <Section title={`Used by (${concept.usedBy.length})`}>
        {concept.usedBy.length === 0 ? (
          <p className="text-sm text-zinc-500">No concepts depend on this one yet.</p>
        ) : (
          concept.usedBy.map((entry, index) => (
            <RelationshipEntry key={`${entry.concept.id}-${index}`} {...entry} />
          ))
        )}
      </Section>

      <Section title={`Related concepts (${concept.related.length})`}>
        {concept.related.length === 0 ? (
          <p className="text-sm text-zinc-500">None identified.</p>
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
          <p className="text-sm text-zinc-500">No sources recorded.</p>
        ) : (
          concept.sources.map((source) => (
            <div key={source.id} className="rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
              <p className="font-medium text-zinc-900 dark:text-zinc-50">
                {source.documentName} · chunk {source.chunkIndex}
              </p>
              <p className="mt-1 italic text-zinc-600 dark:text-zinc-400">&ldquo;{source.evidence}&rdquo;</p>
            </div>
          ))
        )}
      </Section>
    </div>
  );
}
