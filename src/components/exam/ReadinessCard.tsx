import type { ReadinessOutput } from "@/lib/exam/types";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ProgressBar } from "@/components/ui/ProgressBar";

const STATUS_LABEL: Record<ReadinessOutput["status"], string> = {
  NOT_READY: "Not Ready",
  DEVELOPING: "Developing",
  ALMOST_READY: "Almost Ready",
  READY: "Ready",
  MASTERED: "Mastered",
};

const STATUS_TONE: Record<ReadinessOutput["status"], "danger" | "warning" | "success"> = {
  NOT_READY: "danger",
  DEVELOPING: "warning",
  ALMOST_READY: "warning",
  READY: "success",
  MASTERED: "success",
};

const PROGRESS_TONE: Record<ReadinessOutput["status"], "danger" | "warning" | "success"> = STATUS_TONE;

/** Exam Readiness dashboard section (spec §66) — real numbers, no generic motivational text (spec §42). */
export function ReadinessCard({ readiness }: { readiness: ReadinessOutput }) {
  const percent = Math.round(readiness.readiness * 100);

  return (
    <Card className="mt-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium tracking-wide text-fg-muted uppercase">Exam Readiness</h2>
        <Badge tone={STATUS_TONE[readiness.status]}>{STATUS_LABEL[readiness.status]}</Badge>
      </div>

      <div className="mt-3">
        <ProgressBar value={readiness.readiness} tone={PROGRESS_TONE[readiness.status]} label="Exam readiness" />
      </div>
      <p className="mt-2 text-sm text-fg-muted">{percent}%</p>

      <p className="mt-3 text-sm text-fg-muted">{readiness.explanation}</p>

      {readiness.weakAreas.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-fg-subtle uppercase">Needs work</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {readiness.weakAreas.map((name) => (
              <li key={name}>
                <Badge tone="warning">{name}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-sm text-fg-muted">
        <span className="font-medium text-fg">Recommended:</span> {readiness.recommendation}
      </p>
    </Card>
  );
}
