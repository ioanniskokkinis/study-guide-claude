import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from "react";

const FIELD_BASE =
  "focus-ring transition-standard w-full rounded-md border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle disabled:cursor-not-allowed disabled:opacity-50";

function fieldBorder(error?: boolean) {
  return error ? "border-danger" : "border-border";
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ error, className = "", ...props }, ref) {
  return <input ref={ref} aria-invalid={error || undefined} className={`${FIELD_BASE} ${fieldBorder(error)} ${className}`} {...props} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ error, className = "", ...props }, ref) {
  return (
    <textarea
      ref={ref}
      aria-invalid={error || undefined}
      className={`${FIELD_BASE} resize-y ${fieldBorder(error)} ${className}`}
      {...props}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ error, className = "", children, ...props }, ref) {
  return (
    <select ref={ref} aria-invalid={error || undefined} className={`${FIELD_BASE} ${fieldBorder(error)} ${className}`} {...props}>
      {children}
    </select>
  );
});

/** Small helper/error line for a field — pairs with `error` on Input/Textarea/Select via aria-describedby at the callsite. */
export function FieldMessage({ error, children }: { error?: boolean; children: React.ReactNode }) {
  return <p className={`mt-1.5 text-xs ${error ? "text-danger" : "text-fg-muted"}`}>{children}</p>;
}
