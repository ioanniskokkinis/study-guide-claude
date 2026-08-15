"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeleteCourseButton({ courseId, redirectTo }: { courseId: string; redirectTo?: string }) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleDelete() {
    if (!confirm("Delete this course and all its documents? This cannot be undone.")) {
      return;
    }

    setIsDeleting(true);
    const response = await fetch(`/api/courses/${courseId}`, { method: "DELETE" });
    setIsDeleting(false);

    if (response.ok) {
      if (redirectTo) {
        router.push(redirectTo);
      }
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={isDeleting}
      className="text-sm font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
    >
      {isDeleting ? "Deleting…" : "Delete"}
    </button>
  );
}
