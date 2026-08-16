export const KNOWLEDGE_STATUS_LABEL: Record<string, { label: string; className: string }> = {
  NOT_STARTED: { label: "Not built yet", className: "text-zinc-500" },
  QUEUED: { label: "Queued", className: "text-amber-600 dark:text-amber-400" },
  PROCESSING: { label: "⟳ Processing", className: "text-amber-600 dark:text-amber-400" },
  READY: { label: "✓ Ready", className: "text-emerald-600 dark:text-emerald-400" },
  FAILED: { label: "✗ Failed", className: "text-red-600 dark:text-red-400" },
};

export function knowledgeStatusLabel(status: string) {
  return KNOWLEDGE_STATUS_LABEL[status] ?? { label: status, className: "text-zinc-500" };
}
