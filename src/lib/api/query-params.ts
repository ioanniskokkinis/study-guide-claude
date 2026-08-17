/**
 * Parses a `limit`/`page`/`pageSize`-style query param into a clean
 * positive integer, or `undefined` for anything else — missing, empty,
 * non-numeric, zero, negative, non-integer (e.g. "2.5"), or non-finite
 * (e.g. "Infinity"/"NaN"). `undefined` lets the caller fall back to its own
 * default rather than accidentally forwarding something like a fractional
 * value into a Prisma `take`/`skip`, which throws a raw
 * PrismaClientValidationError that would otherwise reach the client
 * unhandled (Phase 19 §19.3/§19.4 — every route already clamps this value
 * again server-side via Math.min/Math.max, so this is about rejecting
 * malformed input cleanly, not about the resource-exhaustion bound itself).
 */
export function parsePositiveIntParam(value: string | null): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
