import { env } from "@/lib/env";
import { LocalStorageProvider } from "./local-storage";
import type { StorageProvider } from "./storage";

/**
 * Generated Tutor audio lives in its own root (`AUDIO_STORAGE_ROOT`,
 * default `./storage/audio`), separate from uploaded course documents
 * (`STORAGE_ROOT`) — same `StorageProvider` implementation and the same
 * path-escape guard, just a different directory (Phase 14 §10).
 */
export const audioStorage: StorageProvider = new LocalStorageProvider(env.AUDIO_STORAGE_ROOT);
