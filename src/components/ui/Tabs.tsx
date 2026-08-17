"use client";

import { useRef } from "react";

export interface TabItem {
  value: string;
  label: string;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  "aria-label": string;
  className?: string;
}

/** Accessible tab list (Phase 18.3): arrow-key roving focus per the WAI-ARIA tabs pattern, not just click handlers. Renders only the tablist — pair each panel with `role="tabpanel"` and `id`/`aria-labelledby` matching `tab-${value}`. */
export function Tabs({ items, value, onChange, className = "", ...props }: TabsProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function focusIndex(index: number) {
    const item = items[(index + items.length) % items.length];
    onChange(item.value);
    refs.current[item.value]?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusIndex(index + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusIndex(index - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusIndex(items.length - 1);
    }
  }

  return (
    <div role="tablist" aria-label={props["aria-label"]} className={`flex gap-1 border-b border-border ${className}`}>
      {items.map((item, index) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            ref={(el) => {
              refs.current[item.value] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${item.value}`}
            aria-selected={active}
            aria-controls={`panel-${item.value}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={`focus-ring transition-standard relative px-3 py-2 text-sm font-medium whitespace-nowrap ${
              active ? "text-fg" : "text-fg-muted hover:text-fg"
            }`}
          >
            {item.label}
            <span
              aria-hidden="true"
              className={`absolute inset-x-1 -bottom-px h-0.5 rounded-full ${active ? "bg-accent" : "bg-transparent"}`}
            />
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ value, active, children }: { value: string; active: boolean; children: React.ReactNode }) {
  if (!active) return null;
  return (
    <div role="tabpanel" id={`panel-${value}`} aria-labelledby={`tab-${value}`} tabIndex={0} className="focus-ring">
      {children}
    </div>
  );
}
