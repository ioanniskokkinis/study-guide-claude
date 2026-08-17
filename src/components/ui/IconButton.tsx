import type { ButtonHTMLAttributes, ReactNode } from "react";

export type IconButtonSize = "sm" | "md";

const SIZE_CLASSES: Record<IconButtonSize, string> = {
  sm: "h-7 w-7 text-xs",
  md: "h-9 w-9 text-sm",
};

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required — an icon-only button with no visible text must always have an accessible name. */
  label: string;
  size?: IconButtonSize;
  active?: boolean;
  icon: ReactNode;
}

/** Icon-only control (Phase 18.3) — always carries aria-label so it's announced correctly by a screen reader. */
export function IconButton({ label, size = "md", active, icon, className = "", ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`focus-ring transition-standard inline-flex shrink-0 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-50 ${
        active ? "bg-surface-muted text-fg" : "text-fg-muted hover:bg-surface-hover hover:text-fg"
      } ${SIZE_CLASSES[size]} ${className}`}
      {...props}
    >
      {icon}
    </button>
  );
}
