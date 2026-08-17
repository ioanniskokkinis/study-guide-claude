import type { ReactNode } from "react";
import { Card } from "./Card";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  sublabel?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}

const TONE_VALUE_CLASSES: Record<NonNullable<StatCardProps["tone"]>, string> = {
  neutral: "text-fg",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

/** Compact metric tile (Phase 18.3) — the building block for course-overview/progress-page stat rows, replacing duplicated `<div><dt/><dd/></div>` grids. */
export function StatCard({ label, value, sublabel, tone = "neutral" }: StatCardProps) {
  return (
    <Card padding="sm" className="text-center">
      <p className="text-xs font-medium text-fg-muted">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${TONE_VALUE_CLASSES[tone]}`}>{value}</p>
      {sublabel && <p className="mt-0.5 text-xs text-fg-subtle">{sublabel}</p>}
    </Card>
  );
}
