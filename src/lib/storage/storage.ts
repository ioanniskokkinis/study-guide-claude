/**
 * Storage abstraction for uploaded files. The local filesystem
 * implementation is used for now; an S3-compatible provider can implement
 * the same interface later without touching callers.
 */
export interface StorageProvider {
  /** Persist `data` under `key`, creating any intermediate directories. */
  save(key: string, data: Buffer): Promise<void>;
  /** Read back the bytes stored under `key`. */
  read(key: string): Promise<Buffer>;
  /** Delete the object at `key`. A missing object is not an error. */
  delete(key: string): Promise<void>;
  /** Check whether an object exists at `key`. */
  exists(key: string): Promise<boolean>;
  /**
   * Lists every key currently stored, recursively, as paths relative to the
   * storage root (Phase 19 §19.9) — the read side a deterministic storage
   * integrity check needs to detect orphan files (on disk, no DB record) as
   * well as orphan records (DB row, no file on disk, which `read`/`exists`
   * alone can already catch one-by-one).
   */
  list(): Promise<string[]>;
}
