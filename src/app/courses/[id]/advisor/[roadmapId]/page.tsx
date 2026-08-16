import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { getRoadmap, getTodayPlan } from "@/lib/advisor/queries";
import { getRoadmapProgress } from "@/lib/advisor/progress";
import { RoadmapView } from "@/components/advisor/RoadmapView";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; roadmapId: string }>;
}

/** Roadmap detail — always DB -> render, never generates anything on load (spec §52). */
export default async function RoadmapPage({ params }: PageProps) {
  const { id: courseId, roadmapId } = await params;
  const user = await getCurrentUser();

  const [roadmap, progress, todayPlan] = await Promise.all([
    getRoadmap(user.id, roadmapId),
    getRoadmapProgress(user.id, roadmapId),
    getTodayPlan(user.id, roadmapId),
  ]);

  if (!roadmap || !progress || !todayPlan) notFound();

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Link href={`/courses/${courseId}`} className="text-sm text-zinc-500 hover:underline">
        ← Course
      </Link>
      <RoadmapView courseId={courseId} roadmap={roadmap} progress={progress} todayPlan={todayPlan} />
    </div>
  );
}
