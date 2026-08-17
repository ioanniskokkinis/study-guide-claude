/** Loading placeholder (Phase 18.3) — one shimmer treatment reused instead of ad-hoc "Loading…" text everywhere a page waits on data. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-surface-muted ${className}`} />;
}

/** A vertical stack of skeleton lines, for text-shaped loading content. */
export function SkeletonText({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={`h-3 ${i === lines - 1 ? "w-2/3" : "w-full"}`} />
      ))}
    </div>
  );
}

/** Announces the loading state to assistive tech while the visual skeletons above stay aria-hidden (they're purely decorative). */
export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-8 text-sm text-fg-muted">
      <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      <span>{label}…</span>
    </div>
  );
}
