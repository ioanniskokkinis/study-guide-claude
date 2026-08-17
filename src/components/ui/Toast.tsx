"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

export type ToastTone = "neutral" | "success" | "danger";

interface ToastEntry {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  show: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_CLASSES: Record<ToastTone, string> = {
  neutral: "border-border bg-surface text-fg",
  success: "border-success-border bg-success-bg text-success-fg",
  danger: "border-danger-border bg-danger-bg text-danger-fg",
};

const AUTO_DISMISS_MS = 4000;

/**
 * Minimal toast system (Phase 18.3) — a single provider mounted once in the
 * root layout, and a `useToast().show(...)` hook anywhere below it. Most of
 * the app still shows errors inline next to the control that caused them
 * (the better pattern for a validation/failure the student needs to act on
 * right there), so this is reserved for transient, non-blocking
 * confirmations (e.g. "Folder created") rather than a wholesale replacement
 * of every inline error state.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(0);

  const show = useCallback((message: string, tone: ToastTone = "neutral") => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), AUTO_DISMISS_MS);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div aria-live="polite" aria-atomic="true" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={`animate-slide-up pointer-events-auto rounded-md border px-4 py-2.5 text-sm shadow-lg ${TONE_CLASSES[toast.tone]}`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider.");
  return ctx;
}
