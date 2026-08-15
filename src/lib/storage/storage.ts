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
}
