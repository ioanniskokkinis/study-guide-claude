import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

/** Consistent "nothing here yet" treatment (Phase 18.3) — replaces one-off `<p className="text-sm text-zinc-500">None yet.</p>` variants scattered across pages. */
export function EmptyState({ icon, title, description, action, className = "" }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center rounded-lg border border-dashed border-border px-6 py-10 text-center ${className}`}>
      {icon && (
        <span aria-hidden="true" className="mb-3 text-2xl text-fg-subtle">
          {icon}
        </span>
      )}
      <p className="text-sm font-medium text-fg">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-fg-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
