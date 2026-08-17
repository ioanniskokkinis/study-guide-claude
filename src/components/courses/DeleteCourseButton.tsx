"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

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
    <Button variant="ghost" size="sm" loading={isDeleting} onClick={handleDelete} className="text-danger hover:bg-danger-bg">
      {isDeleting ? "Deleting…" : "Delete"}
    </Button>
  );
}
