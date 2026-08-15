export const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  UPLOADED: { label: "Uploaded", className: "text-zinc-500" },
  PROCESSING: { label: "⟳ Processing", className: "text-amber-600 dark:text-amber-400" },
  READY: { label: "✓ Ready", className: "text-emerald-600 dark:text-emerald-400" },
  FAILED: { label: "✗ Failed", className: "text-red-600 dark:text-red-400" },
};

export function statusLabel(status: string) {
  return STATUS_LABEL[status] ?? { label: status, className: "text-zinc-500" };
}
