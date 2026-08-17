import type { HTMLAttributes, ReactNode } from "react";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Adds a hover elevation + pointer affordance for cards that are themselves a click target (e.g. wrapped in a Link). */
  interactive?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
}

const PADDING_CLASSES = { none: "", sm: "p-3", md: "p-4 sm:p-5", lg: "p-6 sm:p-8" };

/** The one card container the rest of the app composes (Phase 18.3). */
export function Card({ interactive, padding = "md", className = "", children, ...props }: CardProps) {
  return (
    <div
      className={`rounded-lg border border-border bg-surface ${PADDING_CLASSES[padding]} ${
        interactive ? "transition-standard hover:border-border-strong hover:shadow-md" : ""
      } ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className = "", children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`mb-4 flex items-start justify-between gap-3 ${className}`} {...props}>
      {children}
    </div>
  );
}

export function CardTitle({ children, ...props }: HTMLAttributes<HTMLHeadingElement> & { children: ReactNode }) {
  return (
    <h3 className="text-sm font-semibold text-fg" {...props}>
      {children}
    </h3>
  );
}
