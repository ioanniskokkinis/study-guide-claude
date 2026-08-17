import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getGraphData, getKnowledgeSummary, searchConcepts } from "@/lib/services/knowledge";
import { getDevelopingConcepts, getKnowledgeSnapshot, getRecentMistakes } from "@/lib/services/student-knowledge";
import { KnowledgeGraphProgress } from "@/components/knowledge/KnowledgeGraphProgress";
import { ConceptGraph } from "@/components/knowledge/ConceptGraph";
import { MyKnowledgeSection } from "@/components/knowledge/MyKnowledgeSection";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";

export const dynamic = "force-dynamic";

const FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "prerequisite", label: "Prerequisites" },
  { value: "related", label: "Related" },
  { value: "contains", label: "Contains" },
  { value: "example_of", label: "Example of" },
  { value: "contrasts_with", label: "Contrasts with" },
  { value: "causes", label: "Causes" },
  { value: "part_of", label: "Part of" },
  { value: "applies_to", label: "Applies to" },
];

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; type?: string; page?: string }>;
}

export default async function KnowledgePage({ params, searchParams }: PageProps) {
  const { id: courseId } = await params;
  const { q, type, page } = await searchParams;
  const user = await getCurrentUser();

  const summary = await getKnowledgeSummary(user.id, courseId);
  if (!summary) {
    notFound();
  }

  const activeFilter = type && FILTERS.some((f) => f.value === type) ? type : "all";

  const [conceptResult, graph, knowledgeSnapshot, developingConcepts, mistakes] = await Promise.all([
    searchConcepts(user.id, courseId, { query: q, page: page ? Number(page) : 1 }),
    getGraphData(user.id, courseId, activeFilter === "all" ? undefined : [activeFilter]),
    getKnowledgeSnapshot(user.id, courseId),
    getDevelopingConcepts(user.id, courseId),
    getRecentMistakes(user.id, courseId),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <Link href={`/courses/${courseId}`} className="focus-ring text-sm text-fg-muted hover:text-fg hover:underline">
        ← {summary.courseTitle}
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">Knowledge Graph</h1>

      <div className="mt-4">
        <KnowledgeGraphProgress
          courseId={courseId}
          initialStatus={summary.knowledgeStatus}
          initialProgress={summary.knowledgeProgress}
          initialStageMessage={summary.knowledgeStageMessage}
          initialError={summary.knowledgeError}
          conceptCount={summary.conceptCount}
          relationshipCount={summary.relationshipCount}
          prerequisiteCount={summary.prerequisiteCount}
        />
      </div>

      {knowledgeSnapshot && (
        <MyKnowledgeSection snapshot={knowledgeSnapshot} developingConcepts={developingConcepts ?? []} mistakes={mistakes ?? []} />
      )}

      <div className="mt-10">
        <SectionHeader title="Graph" />
        <div className="mt-3 flex flex-wrap gap-2">
          {FILTERS.map((filter) => {
            const href = `?type=${filter.value}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
            const isActive = filter.value === activeFilter;
            return (
              <Link key={filter.value} href={href}>
                <Button variant={isActive ? "primary" : "secondary"} size="sm">
                  {filter.label}
                </Button>
              </Link>
            );
          })}
        </div>
        <div className="mt-3">
          <ConceptGraph nodes={graph?.nodes ?? []} edges={graph?.edges ?? []} />
        </div>
      </div>

      <div className="mt-10">
        <SectionHeader title="Concepts" />
        <form className="mt-3 flex gap-2" action={`/courses/${courseId}/knowledge`}>
          {activeFilter !== "all" && <input type="hidden" name="type" value={activeFilter} />}
          <Input type="text" name="q" defaultValue={q} placeholder="Search concepts…" className="max-w-sm" />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>

        {!conceptResult || conceptResult.concepts.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              icon="🔎"
              title={summary.conceptCount === 0 ? "No concepts yet" : "No concepts match your search"}
              description={
                summary.conceptCount === 0 ? "Build the knowledge graph to extract concepts from this course's documents." : undefined
              }
            />
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
            {conceptResult.concepts.map((concept) => (
              <li key={concept.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <Link href={`/concepts/${concept.id}`} className="focus-ring rounded font-medium text-fg underline-offset-2 hover:underline">
                    {concept.name}
                  </Link>
                  {concept.description && <p className="truncate text-xs text-fg-subtle">{concept.description}</p>}
                </div>
                <div className="shrink-0 text-right text-xs text-fg-subtle">
                  <p>Difficulty {concept.difficulty}/5</p>
                  <p>
                    {concept.sourceCount} source{concept.sourceCount === 1 ? "" : "s"} · {concept.relationshipCount} link
                    {concept.relationshipCount === 1 ? "" : "s"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
