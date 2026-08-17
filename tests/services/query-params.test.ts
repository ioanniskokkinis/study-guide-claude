import { describe, expect, it } from "vitest";
import { parsePositiveIntParam } from "@/lib/api/query-params";

/**
 * Phase 19 §19.2/§19.3 regression: several routes' `limit`/`page`/`pageSize`
 * query params only checked `Number.isFinite`, which still let a negative,
 * zero, fractional, or NaN-adjacent value ("Infinity") pass through toward
 * a Prisma `take`/`skip` — this is the shared, tested replacement.
 */
describe("parsePositiveIntParam", () => {
  it("parses a valid positive integer string", () => {
    expect(parsePositiveIntParam("20")).toBe(20);
    expect(parsePositiveIntParam("1")).toBe(1);
  });

  it("returns undefined for missing or empty input", () => {
    expect(parsePositiveIntParam(null)).toBeUndefined();
    expect(parsePositiveIntParam("")).toBeUndefined();
    expect(parsePositiveIntParam("   ")).toBeUndefined();
  });

  it("returns undefined for non-numeric input", () => {
    expect(parsePositiveIntParam("abc")).toBeUndefined();
    expect(parsePositiveIntParam("20abc")).toBeUndefined();
  });

  it("returns undefined for zero or negative values", () => {
    expect(parsePositiveIntParam("0")).toBeUndefined();
    expect(parsePositiveIntParam("-5")).toBeUndefined();
  });

  it("returns undefined for fractional values", () => {
    expect(parsePositiveIntParam("2.5")).toBeUndefined();
  });

  it("returns undefined for non-finite values", () => {
    expect(parsePositiveIntParam("Infinity")).toBeUndefined();
    expect(parsePositiveIntParam("-Infinity")).toBeUndefined();
    expect(parsePositiveIntParam("NaN")).toBeUndefined();
  });
});
