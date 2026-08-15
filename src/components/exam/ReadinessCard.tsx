import type { ReadinessOutput } from "@/lib/exam/types";

const STATUS_LABEL: Record<ReadinessOutput["status"], string> = {
  NOT_READY: "Not Ready",
  DEVELOPING: "Developing",
  ALMOST_READY: "Almost Ready",
  READY: "Ready",
  MASTERED: "Mastered",
};

const STATUS_COLOR: Record<ReadinessOutput["status"], string> = {
  NOT_READY: "bg-red-500",
  DEVELOPING: "bg-amber-500",
  ALMOST_READY: "bg-amber-400",
  READY: "bg-emerald-500",
  MASTERED: "bg-emerald-600",
};

/** Exam Readiness dashboard section (spec §66) — real numbers, no generic motivational text (spec §42). */
export function ReadinessCard({ readiness }: { readiness: ReadinessOutput }) {
  const percent = Math.round(readiness.readiness * 100);

  return (
    <div className="mt-6 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <h2 className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Exam Readiness</h2>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
        <div className={`h-full ${STATUS_COLOR[readiness.status]}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-2 text-sm text-zinc-500">
        {percent}% · <span className="font-medium text-zinc-700 dark:text-zinc-300">{STATUS_LABEL[readiness.status]}</span>
      </p>

      <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">{readiness.explanation}</p>

      {readiness.weakAreas.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-zinc-400 uppercase">Needs work</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {readiness.weakAreas.map((name) => (
              <li key={name} className="rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                {name}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-sm text-zinc-500">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Recommended:</span> {readiness.recommendation}
      </p>
    </div>
  );
}
