import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { checkHealth } from "@/lib/health";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";

/**
 * Phase 19 §19.21 — /api/health must distinguish Application healthy /
 * Database unavailable / Storage unavailable / Configuration invalid,
 * and must never make an external Claude/TTS call to answer the question.
 */
describe("checkHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports healthy when the database is reachable, storage is writable, and ANTHROPIC_API_KEY is configured", async () => {
    // This sandbox's own .env intentionally leaves ANTHROPIC_API_KEY empty
    // (no real key available in tests) — set a fake truthy value just for
    // this assertion so it exercises the "everything is fine" path for real.
    const original = env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_API_KEY = "test-anthropic-api-key";
    try {
      const result = await checkHealth();
      expect(result.status).toBe("healthy");
      expect(result.checks.database.status).toBe("ok");
      expect(result.checks.storage.status).toBe("ok");
      expect(result.checks.configuration.status).toBe("ok");
    } finally {
      env.ANTHROPIC_API_KEY = original;
    }
  });

  it("reports the database check as failed (without leaking the raw error) when the DB is unreachable", async () => {
    vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("connection refused to 10.0.0.5:5432 user=admin"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await checkHealth();
    expect(result.status).toBe("degraded");
    expect(result.checks.database.status).toBe("error");
    expect(result.checks.database.message).not.toContain("10.0.0.5");
    expect(result.checks.database.message).not.toContain("admin");
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("reports the storage check as failed when the storage root is not writable", async () => {
    vi.spyOn(fs, "mkdir").mockRejectedValueOnce(new Error("EACCES: permission denied, mkdir '/var/secret/uploads'"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await checkHealth();
    expect(result.status).toBe("degraded");
    expect(result.checks.storage.status).toBe("error");
    expect(result.checks.storage.message).not.toContain("/var/secret/uploads");
  });

  it("reports configuration as failed when ANTHROPIC_API_KEY is missing", async () => {
    const original = env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_API_KEY = "";
    vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await checkHealth();
      expect(result.status).toBe("degraded");
      expect(result.checks.configuration.status).toBe("error");
      expect(result.checks.configuration.message).toMatch(/ANTHROPIC_API_KEY/);
    } finally {
      env.ANTHROPIC_API_KEY = original;
    }
  });
});
