import { cloneElement, isValidElement, useId, type ReactElement } from "react";

export interface TooltipProps {
  content: string;
  /** A single focusable element (button/link) — required so aria-describedby can attach directly to it. */
  children: ReactElement<{ "aria-describedby"?: string }>;
  side?: "top" | "bottom";
}

/**
 * Lightweight CSS-only tooltip (Phase 18.3) — no positioning library, shown
 * on hover *and* keyboard focus (so it's reachable without a mouse), and
 * respects reduced-motion via the global rule in globals.css.
 * `aria-describedby` is attached directly to the trigger element (not a
 * wrapping span) so assistive tech actually associates the tooltip text
 * with it.
 */
export function Tooltip({ content, children, side = "top" }: TooltipProps) {
  const id = useId();
  const trigger = isValidElement(children) ? cloneElement(children, { "aria-describedby": id }) : children;

  return (
    <span className="group relative inline-flex">
      {trigger}
      <span
        role="tooltip"
        id={id}
        className={`animate-fade-in pointer-events-none absolute left-1/2 z-50 hidden -translate-x-1/2 rounded-md bg-fg px-2 py-1 text-xs whitespace-nowrap text-bg shadow-md group-hover:block group-focus-within:block ${
          side === "top" ? "bottom-full mb-2" : "top-full mt-2"
        }`}
      >
        {content}
      </span>
    </span>
  );
}
