import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getRoadmap, getTodayPlan } from "@/lib/advisor/queries";
import { getRoadmapProgress } from "@/lib/advisor/progress";
import { getRoadmapHealthForRoadmap } from "@/lib/advisor/health";
import { checkAdaptationNeeded } from "@/lib/advisor/change-detection";
import { RoadmapView } from "@/components/advisor/RoadmapView";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; roadmapId: string }>;
}

/**
 * Roadmap detail — always DB -> render, never generates anything on load
 * (spec §52). Health and the adaptation-needed check are both pure
 * deterministic reads (no AI, no writes) — safe to compute on every
 * navigation, same as progress already was in Phase 15.
 */
export default async function RoadmapPage({ params }: PageProps) {
  const { id: courseId, roadmapId } = await params;
  const user = await getCurrentUser();

  const [roadmap, progress, todayPlan, health, adaptation] = await Promise.all([
    getRoadmap(user.id, roadmapId),
    getRoadmapProgress(user.id, roadmapId),
    getTodayPlan(user.id, roadmapId),
    getRoadmapHealthForRoadmap(user.id, roadmapId),
    checkAdaptationNeeded(user.id, roadmapId).catch(() => null),
  ]);

  if (!roadmap || !progress || !todayPlan || !health) notFound();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <Link href={`/courses/${courseId}`} className="focus-ring text-sm text-fg-muted hover:text-fg hover:underline">
        ← Course
      </Link>
      <RoadmapView
        courseId={courseId}
        roadmap={roadmap}
        progress={progress}
        todayPlan={todayPlan}
        health={health}
        adaptation={adaptation}
      />
    </div>
  );
}
