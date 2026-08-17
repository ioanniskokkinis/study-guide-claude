import { Button } from "./Button";

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}

/** Consistent, non-alarming failure treatment (Phase 18.3/17 §36) — never a raw stack trace or internal error string, always a plain-language message with a way to recover. */
export function ErrorState({ title = "Something went wrong", message, onRetry, className = "" }: ErrorStateProps) {
  return (
    <div role="alert" className={`rounded-lg border border-danger-border bg-danger-bg px-4 py-3.5 text-sm ${className}`}>
      <p className="font-medium text-danger-fg">{title}</p>
      <p className="mt-1 text-danger-fg/90">{message}</p>
      {onRetry && (
        <div className="mt-3">
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

/** Compact inline variant for form-adjacent errors (Phase 17 answer submission, etc.) — no border/box, just the message. */
export function InlineError({ message }: { message: string }) {
  return (
    <p role="alert" className="text-sm text-danger">
      {message}
    </p>
  );
}
