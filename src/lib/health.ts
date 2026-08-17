import { promises as fs } from "node:fs";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";

/**
 * Deterministic, local-only health check (Phase 19 §19.21). Deliberately
 * never calls Claude/TTS providers to determine health — an external API
 * being slow or rate-limited is not the same question as "is this
 * application deployment healthy," and paying for/waiting on a Claude call
 * on every health probe (load balancers hit this frequently) would be
 * wasteful and misleading. Configuration is checked by presence, not by
 * calling out to verify credentials work.
 */

export type HealthCheckStatus = "ok" | "error";

export interface HealthCheck {
  status: HealthCheckStatus;
  message?: string;
}

export interface HealthCheckResult {
  status: "healthy" | "degraded";
  checks: {
    database: HealthCheck;
    storage: HealthCheck;
    configuration: HealthCheck;
  };
  timestamp: string;
}

async function checkDatabase(): Promise<HealthCheck> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok" };
  } catch (error) {
    console.error("[health] database check failed:", error);
    return { status: "error", message: "Database is unreachable." };
  }
}

/** Verifies both storage roots are writable — never leaks the actual filesystem paths in the response (spec §19.4/§19.9). */
async function checkStorage(): Promise<HealthCheck> {
  try {
    await fs.mkdir(env.STORAGE_ROOT, { recursive: true });
    await fs.mkdir(env.AUDIO_STORAGE_ROOT, { recursive: true });
    await fs.access(env.STORAGE_ROOT);
    await fs.access(env.AUDIO_STORAGE_ROOT);
    return { status: "ok" };
  } catch (error) {
    console.error("[health] storage check failed:", error);
    return { status: "error", message: "Storage is unavailable." };
  }
}

/** Presence-only checks — required for the features that are actually enabled, not a blanket "every possible var must be set." */
function checkConfiguration(): HealthCheck {
  const problems: string[] = [];

  if (!env.ANTHROPIC_API_KEY) {
    problems.push("ANTHROPIC_API_KEY is not configured.");
  }
  if (env.TTS_ENABLED && !env.TTS_API_KEY) {
    problems.push("TTS_ENABLED is true but TTS_API_KEY is not configured.");
  }

  if (problems.length === 0) return { status: "ok" };
  console.error("[health] configuration check failed:", problems.join(" "));
  return { status: "error", message: problems.join(" ") };
}

export async function checkHealth(): Promise<HealthCheckResult> {
  const [database, storage] = await Promise.all([checkDatabase(), checkStorage()]);
  const configuration = checkConfiguration();

  const allOk = database.status === "ok" && storage.status === "ok" && configuration.status === "ok";

  return {
    status: allOk ? "healthy" : "degraded",
    checks: { database, storage, configuration },
    timestamp: new Date().toISOString(),
  };
}
