import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";
import type { StorageProvider } from "./storage";

/**
 * Local filesystem storage provider. Files live outside the public web
 * directory (`STORAGE_ROOT`, default `./storage/uploads`) and are never
 * served through a public URL.
 */
export class LocalStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolveKey(key: string): string {
    const resolved = path.resolve(this.root, key);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new Error("Invalid storage key: resolved path escapes the storage root");
    }
    return resolved;
  }

  async save(key: string, data: Buffer): Promise<void> {
    const target = this.resolveKey(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }

  async read(key: string): Promise<Buffer> {
    return fs.readFile(this.resolveKey(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolveKey(key));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }
}

export const storage: StorageProvider = new LocalStorageProvider(env.STORAGE_ROOT);
