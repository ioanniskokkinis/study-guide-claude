"use client";

import { useSyncExternalStore } from "react";

type ThemeChoice = "system" | "light" | "dark";

const listeners = new Set<() => void>();

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

function readChoice(): ThemeChoice {
  const stored = localStorage.getItem("theme");
  return stored === "light" || stored === "dark" ? stored : "system";
}

function getServerSnapshot(): ThemeChoice {
  return "system";
}

function applyTheme(choice: ThemeChoice) {
  if (choice === "system") {
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem("theme");
  } else {
    document.documentElement.setAttribute("data-theme", choice);
    localStorage.setItem("theme", choice);
  }
  for (const listener of listeners) listener();
}

function nextChoice(current: ThemeChoice): ThemeChoice {
  if (current === "system") return "light";
  if (current === "light") return "dark";
  return "system";
}

const ICON: Record<ThemeChoice, string> = { system: "\u{1F5A5}", light: "☀", dark: "\u{1F319}" };
const LABEL: Record<ThemeChoice, string> = { system: "System", light: "Light", dark: "Dark" };

/**
 * Cycles System -> Light -> Dark -> System (Phase 18.1/18.2). Uses
 * useSyncExternalStore (React's own mechanism for subscribing to state that
 * lives outside React, e.g. localStorage) rather than useState+useEffect —
 * that would need to call setState synchronously on mount just to read the
 * stored choice, which is exactly the anti-pattern useSyncExternalStore
 * exists to replace. getServerSnapshot returns "system" so SSR output
 * matches ThemeScript's default (data-theme unset) before hydration.
 */
export function ThemeToggle() {
  const choice = useSyncExternalStore(subscribe, readChoice, getServerSnapshot);

  return (
    <button
      type="button"
      onClick={() => applyTheme(nextChoice(choice))}
      className="focus-ring transition-standard flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-surface-hover hover:text-fg"
      aria-label={`Theme: ${LABEL[choice]}. Click to switch.`}
      title={`Theme: ${LABEL[choice]}`}
    >
      <span aria-hidden="true" className="text-sm leading-none">
        {ICON[choice]}
      </span>
    </button>
  );
}
