import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getGraphData, getKnowledgeSummary, searchConcepts } from "@/lib/services/knowledge";
import { getDevelopingConcepts, getKnowledgeSnapshot, getRecentMistakes } from "@/lib/services/student-knowledge";
import { BuildKnowledgeGraphButton } from "@/components/knowledge/BuildKnowledgeGraphButton";
import { ConceptGraph } from "@/components/knowledge/ConceptGraph";
import { MyKnowledgeSection } from "@/components/knowledge/MyKnowledgeSection";
import { knowledgeStatusLabel } from "@/components/knowledge/status-label";

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

  const status = knowledgeStatusLabel(summary.knowledgeStatus);

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <Link href={`/courses/${courseId}`} className="text-sm text-zinc-500 hover:underline">
        ← {summary.courseTitle}
      </Link>
      <div className="mt-1 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Knowledge Graph
        </h1>
        <span className={`text-sm font-medium ${status.className}`}>{status.label}</span>
      </div>

      <div className="mt-4">
        <BuildKnowledgeGraphButton courseId={courseId} />
      </div>

      {summary.knowledgeError && (
        <p className="mt-3 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {summary.knowledgeError}
        </p>
      )}

      <dl className="mt-6 grid grid-cols-3 gap-4 rounded-lg border border-zinc-200 p-4 text-center dark:border-zinc-800">
        <div>
          <dt className="text-xs text-zinc-400">Concepts</dt>
          <dd className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{summary.conceptCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-400">Relationships</dt>
          <dd className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{summary.relationshipCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-400">Prerequisites</dt>
          <dd className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{summary.prerequisiteCount}</dd>
        </div>
      </dl>

      {knowledgeSnapshot && (
        <MyKnowledgeSection
          snapshot={knowledgeSnapshot}
          developingConcepts={developingConcepts ?? []}
          mistakes={mistakes ?? []}
        />
      )}

      <div className="mt-8">
        <h2 className="text-sm font-medium text-zinc-500">Graph</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {FILTERS.map((filter) => {
            const href = `?type=${filter.value}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
            const isActive = filter.value === activeFilter;
            return (
              <Link
                key={filter.value}
                href={href}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  isActive
                    ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                    : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900"
                }`}
              >
                {filter.label}
              </Link>
            );
          })}
        </div>
        <div className="mt-3">
          <ConceptGraph nodes={graph?.nodes ?? []} edges={graph?.edges ?? []} />
        </div>
      </div>

      <div className="mt-8">
        <h2 className="text-sm font-medium text-zinc-500">Concepts</h2>
        <form className="mt-2 flex gap-2" action={`/courses/${courseId}/knowledge`}>
          {activeFilter !== "all" && <input type="hidden" name="type" value={activeFilter} />}
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="Search concepts…"
            className="w-full max-w-sm rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-transparent"
          />
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Search
          </button>
        </form>

        {!conceptResult || conceptResult.concepts.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">
            {summary.conceptCount === 0
              ? "No concepts yet — build the knowledge graph to extract them from this course's documents."
              : "No concepts match your search."}
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {conceptResult.concepts.map((concept) => (
              <li key={concept.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <Link
                    href={`/concepts/${concept.id}`}
                    className="font-medium text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-50"
                  >
                    {concept.name}
                  </Link>
                  {concept.description && (
                    <p className="truncate text-xs text-zinc-400">{concept.description}</p>
                  )}
                </div>
                <div className="shrink-0 text-right text-xs text-zinc-400">
                  <p>Difficulty {concept.difficulty}/5</p>
                  <p>
                    {concept.sourceCount} source{concept.sourceCount === 1 ? "" : "s"} ·{" "}
                    {concept.relationshipCount} link{concept.relationshipCount === 1 ? "" : "s"}
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
