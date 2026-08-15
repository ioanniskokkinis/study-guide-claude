import { describe, expect, it } from "vitest";
import { loadEnv } from "@/lib/env";

describe("loadEnv", () => {
  it("parses a valid environment and applies defaults", () => {
    const env = loadEnv({
      ...process.env,
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
    });

    expect(env.DATABASE_URL).toBe("postgresql://user:pass@localhost:5432/db");
    expect(env.ANTHROPIC_MODEL_DEFAULT).toBe("claude-sonnet-5");
    expect(env.STORAGE_ROOT).toBe("./storage/uploads");
    expect(env.MAX_UPLOAD_SIZE_MB).toBeGreaterThan(0);
    expect(env.DOCUMENT_CHUNK_SIZE).toBeGreaterThan(0);
    expect(env.DOCUMENT_CHUNK_OVERLAP).toBeGreaterThanOrEqual(0);
  });

  it("coerces numeric env vars from strings", () => {
    const env = loadEnv({
      ...process.env,
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      MAX_UPLOAD_SIZE_MB: "25",
      DOCUMENT_CHUNK_SIZE: "800",
      DOCUMENT_CHUNK_OVERLAP: "100",
    });

    expect(env.MAX_UPLOAD_SIZE_MB).toBe(25);
    expect(env.DOCUMENT_CHUNK_SIZE).toBe(800);
    expect(env.DOCUMENT_CHUNK_OVERLAP).toBe(100);
  });

  it("throws when DATABASE_URL is missing", () => {
    const rest = { ...process.env };
    delete rest.DATABASE_URL;
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });
});
