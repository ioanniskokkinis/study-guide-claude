/**
 * A tiny in-memory TTL cache (Phase 12 §11) — same documented scope as
 * `src/lib/rate-limit.ts`'s own in-memory bucket map: a single-process
 * dev/MVP mechanism, not a distributed cache. A production SaaS deployment
 * running multiple instances should replace this with Redis or another
 * shared cache; nothing here assumes single-process behavior beyond that
 * (keys are plain strings, values are structurally cloneable), so swapping
 * the backing store later doesn't require touching call sites.
 *
 * Deliberately generic and content-addressed — callers own building a key
 * that's safe to share (Phase 12 §11 explicitly forbids returning one
 * student's personalized response to another; every current caller keys on
 * at least (userId, sessionId, content) to guarantee that).
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Test-only: clears every entry so cache state never leaks between test cases. */
export function __clearCacheForTests(): void {
  store.clear();
}
