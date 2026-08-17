export type ProgressTone = "accent" | "success" | "warning" | "danger" | "info";

const TONE_STROKE: Record<ProgressTone, string> = {
  accent: "stroke-accent",
  success: "stroke-success",
  warning: "stroke-warning",
  danger: "stroke-danger",
  info: "stroke-info",
};

export interface ProgressRingProps {
  /** 0-1. */
  value: number;
  tone?: ProgressTone;
  size?: number;
  strokeWidth?: number;
  label?: string;
  /** Center content — usually the percentage as text; falls back to the computed percentage. */
  children?: React.ReactNode;
}

/** Circular progress indicator (Phase 18.3) — the overall-mastery "at a glance" treatment used on the course overview and progress pages. */
export function ProgressRing({ value, tone = "accent", size = 72, strokeWidth = 6, label, children }: ProgressRingProps) {
  const clamped = Math.min(1, Math.max(0, value));
  const percent = Math.round(clamped * 100);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped);

  return (
    <div
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} strokeWidth={strokeWidth} className="fill-none stroke-surface-muted" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={`transition-standard fill-none ${TONE_STROKE[tone]}`}
        />
      </svg>
      <span className="absolute text-sm font-semibold text-fg">{children ?? `${percent}%`}</span>
    </div>
  );
}
