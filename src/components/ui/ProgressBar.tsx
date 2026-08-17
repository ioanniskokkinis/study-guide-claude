export type ProgressTone = "accent" | "success" | "warning" | "danger" | "info";

const TONE_CLASSES: Record<ProgressTone, string> = {
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

export interface ProgressBarProps {
  /** 0-1. */
  value: number;
  tone?: ProgressTone;
  label?: string;
  className?: string;
}

/** Horizontal progress meter (Phase 18.3) — used for mastery/session/roadmap progress. Announces itself via role="progressbar" so a screen reader gets the percentage even though the fill is purely visual. */
export function ProgressBar({ value, tone = "accent", label, className = "" }: ProgressBarProps) {
  const clamped = Math.min(1, Math.max(0, value));
  const percent = Math.round(clamped * 100);
  return (
    <div
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={`h-1.5 w-full overflow-hidden rounded-full bg-surface-muted ${className}`}
    >
      <div
        className={`transition-standard h-full rounded-full ${TONE_CLASSES[tone]}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
