export const MASTERY_STATUS_LABEL: Record<string, { label: string; className: string }> = {
  UNKNOWN: { label: "Unknown", className: "text-zinc-400" },
  LEARNING: { label: "Learning", className: "text-red-600 dark:text-red-400" },
  NEEDS_REMEDIATION: { label: "Needs remediation", className: "text-red-600 dark:text-red-400" },
  DEVELOPING: { label: "Developing", className: "text-amber-600 dark:text-amber-400" },
  STRONG: { label: "Strong", className: "text-emerald-600 dark:text-emerald-400" },
  MASTERED: { label: "Mastered", className: "text-emerald-600 dark:text-emerald-400" },
};

export function masteryStatusLabel(status: string) {
  return MASTERY_STATUS_LABEL[status] ?? { label: status, className: "text-zinc-500" };
}

export const MASTERY_BUCKET_LABEL: Record<string, { label: string; className: string }> = {
  strong: { label: "Strong", className: "text-emerald-600 dark:text-emerald-400" },
  developing: { label: "Developing", className: "text-amber-600 dark:text-amber-400" },
  weak: { label: "Weak", className: "text-red-600 dark:text-red-400" },
  unknown: { label: "Unknown", className: "text-zinc-400" },
};

export function formatMasteryPercent(overallMastery: number): string {
  return `${Math.round(overallMastery * 100)}%`;
}
