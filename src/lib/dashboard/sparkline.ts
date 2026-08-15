/**
 * Pure SVG polyline-point math for a small trend sparkline — no charting
 * library, matching the zero-dependency SVG convention already used by
 * the knowledge graph visualization (src/lib/knowledge/graph-layout.ts).
 */

export interface WeeklyMasteryPoint {
  weekStart: Date;
  averageScore: number | null;
  sampleCount: number;
}

/** Buckets evidence scores into fixed calendar weeks ending "now", most recent last — a real, deterministic trend, not a fabricated one. Weeks with no activity come back as `averageScore: null`. */
export function buildWeeklyMasteryTrend(
  evidence: Array<{ score: number; createdAt: Date }>,
  weeks: number,
  now: Date = new Date(),
): WeeklyMasteryPoint[] {
  const points: WeeklyMasteryPoint[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const weekStart = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const inWeek = evidence.filter((e) => e.createdAt >= weekStart && e.createdAt < weekEnd);
    points.push({
      weekStart,
      averageScore: inWeek.length > 0 ? inWeek.reduce((sum, e) => sum + e.score, 0) / inWeek.length : null,
      sampleCount: inWeek.length,
    });
  }
  return points;
}

/** SVG path `d` attribute for a 0-1-valued trend line, connecting only the weeks with data (gaps in activity leave a visible break rather than a misleading interpolated line). Returns "" if fewer than 2 known points exist — not enough to draw a line. */
export function buildSparklinePath(values: Array<number | null>, width: number, height: number): string {
  const n = values.length;
  if (n < 2) return "";
  const stepX = width / (n - 1);

  const segments: string[] = [];
  let penDown = false;
  values.forEach((value, i) => {
    if (value == null) {
      penDown = false;
      return;
    }
    const x = (i * stepX).toFixed(1);
    const y = (height - value * height).toFixed(1);
    segments.push(`${penDown ? "L" : "M"} ${x},${y}`);
    penDown = true;
  });
  return segments.join(" ");
}
