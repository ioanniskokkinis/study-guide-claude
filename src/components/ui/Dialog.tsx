"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { IconButton } from "./IconButton";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Modal dialog (Phase 18.3) built on the native `<dialog>` element — focus
 * trapping, Escape-to-close, and inert background content all come from
 * the browser instead of being hand-rolled. `onClose` fires from the
 * native `close` event so a click on the ::backdrop (which the browser
 * also closes the dialog for) stays in sync with React state.
 */
export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleClose = () => onClose();
    el.addEventListener("close", handleClose);
    return () => el.removeEventListener("close", handleClose);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
      className="animate-scale-in m-auto w-full max-w-md rounded-lg border border-border bg-surface p-0 text-fg shadow-lg backdrop:bg-fg/40 backdrop:backdrop-blur-sm"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <h2 id="dialog-title" className="text-sm font-semibold text-fg">
          {title}
        </h2>
        <IconButton label="Close" size="sm" onClick={() => ref.current?.close()} icon={<span aria-hidden="true">✕</span>} />
      </div>
      <div className="px-5 py-4">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">{footer}</div>}
    </dialog>
  );
}
