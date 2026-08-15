import Link from "next/link";
import { prisma } from "@/lib/db/prisma";

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
    <div className="flex flex-1 items-center justify-center bg-zinc-50 dark:bg-black">
      <main className="w-full max-w-xl px-8 py-16">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          AI Study Coach
        </h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          Foundation is running. The knowledge graph and adaptive study
          modes ship in later phases.
        </p>

        <Link
          href="/courses"
          className="mt-6 inline-block rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Go to Courses
        </Link>

        <dl className="mt-8 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-sm text-zinc-600 dark:text-zinc-400">
              Database
            </dt>
            <dd
              className={`text-sm font-medium ${
                dbStatus === "connected"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400"
              }`}
            >
              {dbStatus}
            </dd>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-sm text-zinc-600 dark:text-zinc-400">
              Health check
            </dt>
            <dd className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
              <a href="/api/health" className="underline underline-offset-2">
                /api/health
              </a>
            </dd>
          </div>
        </dl>
      </main>
    </div>
  );
}
