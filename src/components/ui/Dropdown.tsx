"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export interface DropdownItem {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
}

export interface DropdownProps {
  trigger: ReactNode;
  items: DropdownItem[];
  align?: "left" | "right";
}

/** Simple menu button (Phase 18.3) — closes on Escape or an outside click, and the trigger's aria-expanded stays in sync so the state is announced. */
export function Dropdown({ trigger, items, align = "right" }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="focus-ring rounded-md">
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className={`animate-scale-in absolute z-50 mt-1.5 min-w-40 origin-top-right rounded-md border border-border bg-surface py-1 shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={`transition-standard block w-full px-3 py-2 text-left text-sm hover:bg-surface-hover ${
                item.destructive ? "text-danger" : "text-fg"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
