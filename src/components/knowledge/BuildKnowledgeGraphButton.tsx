"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const STAGES = [
  "Extracting concepts…",
  "Normalizing & deduplicating…",
  "Finding relationships…",
  "Analyzing prerequisites…",
  "Validating graph…",
];

export function BuildKnowledgeGraphButton({ courseId }: { courseId: string }) {
  const router = useRouter();
  const [isBuilding, setIsBuilding] = useState(false);
  const [stageIndex, setStageIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isBuilding) {
      return;
    }
    const interval = setInterval(() => {
      setStageIndex((current) => Math.min(current + 1, STAGES.length - 1));
    }, 1500);
    return () => clearInterval(interval);
  }, [isBuilding]);

  async function handleClick() {
    setError(null);
    setStageIndex(0);
    setIsBuilding(true);

    try {
      const response = await fetch(`/api/courses/${courseId}/knowledge/build`, { method: "POST" });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(body.error ?? "Could not build the knowledge graph.");
      }
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        setError(body.errors.join(" "));
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the knowledge graph.");
    } finally {
      setIsBuilding(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={isBuilding}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-70 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {isBuilding ? STAGES[stageIndex] : "Build Knowledge Graph"}
      </button>
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
