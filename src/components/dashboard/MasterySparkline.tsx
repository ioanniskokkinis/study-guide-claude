import { buildSparklinePath, type WeeklyMasteryPoint } from "@/lib/dashboard/sparkline";

const WIDTH = 320;
const HEIGHT = 64;

export function MasterySparkline({ trend }: { trend: WeeklyMasteryPoint[] }) {
  const knownWeeks = trend.filter((p) => p.averageScore != null);
  if (knownWeeks.length < 2) {
    return <p className="text-sm text-fg-muted">Not enough history yet to show a trend — check back after a few study sessions.</p>;
  }

  const path = buildSparklinePath(
    trend.map((p) => p.averageScore),
    WIDTH,
    HEIGHT,
  );
  const first = knownWeeks[0]!;
  const last = knownWeeks[knownWeeks.length - 1]!;

  return (
    <div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-16 w-full" preserveAspectRatio="none" role="img" aria-label="Mastery trend over recent weeks">
        <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth={2} />
      </svg>
      <div className="mt-1 flex justify-between text-xs text-fg-subtle">
        <span>{Math.round(first.averageScore! * 100)}% ({first.weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })})</span>
        <span>{Math.round(last.averageScore! * 100)}% ({last.weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })})</span>
      </div>
    </div>
  );
}
