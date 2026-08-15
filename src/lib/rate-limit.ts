/**
 * Simple in-memory fixed-window rate limiter (spec §35). This is a
 * single-process dev/MVP mechanism, not a distributed limiter — sufficient
 * to stop accidental rapid-fire clicks/retries from hammering the Claude
 * API, not intended to withstand adversarial abuse at scale.
 */
interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export function checkRateLimit(key: string, opts: { maxRequests: number; windowMs: number }): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= opts.windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (bucket.count >= opts.maxRequests) {
    return { allowed: false, retryAfterMs: opts.windowMs - (now - bucket.windowStart) };
  }

  bucket.count += 1;
  return { allowed: true };
}
