import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

// Reflects live DB connectivity — must not be frozen at build time.
export const dynamic = "force-dynamic";

async function getDbStatus() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "connected" as const;
  } catch {
    return "unreachable" as const;
  }
}

export default async function Home() {
  const dbStatus = await getDbStatus();

  return (
    <div className="flex flex-1 items-center justify-center">
      <main className="w-full max-w-xl px-8 py-16">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">AI Study Coach</h1>
        <p className="mt-2 text-fg-muted">
          Foundation is running. The knowledge graph and adaptive study modes ship in later phases.
        </p>

        <Link href="/courses" className="mt-6 inline-block">
          <Button variant="primary">Go to Courses</Button>
        </Link>

        <dl className="mt-8 divide-y divide-border rounded-lg border border-border">
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-sm text-fg-muted">Database</dt>
            <dd>
              <Badge tone={dbStatus === "connected" ? "success" : "danger"}>{dbStatus}</Badge>
            </dd>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-sm text-fg-muted">Health check</dt>
            <dd className="text-sm font-medium text-fg">
              <a href="/api/health" className="focus-ring rounded underline underline-offset-2">
                /api/health
              </a>
            </dd>
          </div>
        </dl>
      </main>
    </div>
  );
}
