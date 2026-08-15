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
  });

  it("throws when DATABASE_URL is missing", () => {
    const rest = { ...process.env };
    delete rest.DATABASE_URL;
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });
});
