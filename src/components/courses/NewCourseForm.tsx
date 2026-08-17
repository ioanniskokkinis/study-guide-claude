"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { InlineError } from "@/components/ui/ErrorState";

export function NewCourseForm() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description }),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(body.error ?? "Could not create the course.");
      }

      setTitle("");
      setDescription("");
      setIsOpen(false);
      router.push(`/courses/${body.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the course.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!isOpen) {
    return (
      <Button variant="primary" onClick={() => setIsOpen(true)}>
        + New Course
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="animate-slide-up rounded-lg border border-border p-4">
      <div className="flex flex-col gap-3">
        <Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Course title" required />
        <Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description (optional)" rows={2} />
        {error && <InlineError message={error} />}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={isSubmitting}>
            {isSubmitting ? "Creating…" : "Create"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
}
