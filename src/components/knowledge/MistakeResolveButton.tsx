"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function MistakeResolveButton({ mistakeId }: { mistakeId: string }) {
  const router = useRouter();
  const [isResolving, setIsResolving] = useState(false);

  async function handleResolve() {
    setIsResolving(true);
    const response = await fetch(`/api/mistakes/${mistakeId}`, { method: "PATCH" });
    setIsResolving(false);

    if (response.ok) {
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={handleResolve}
      disabled={isResolving}
      className="text-sm font-medium text-zinc-600 hover:underline disabled:opacity-50 dark:text-zinc-400"
    >
      {isResolving ? "Marking reviewed…" : "Mark reviewed"}
    </button>
  );
}
