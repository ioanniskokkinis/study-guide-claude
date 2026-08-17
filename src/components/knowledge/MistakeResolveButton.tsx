"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

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
    <Button variant="ghost" size="sm" loading={isResolving} onClick={handleResolve}>
      {isResolving ? "Marking reviewed…" : "Mark reviewed"}
    </Button>
  );
}
