import { prisma } from "@/lib/db/prisma";
import { storage } from "./local-storage";
import { audioStorage } from "./audio-storage";
import type { StorageProvider } from "./storage";

export interface StorageIntegrityReport {
  /** DB rows whose referenced key has no corresponding file on disk. */
  missingFiles: Array<{ recordId: string; key: string }>;
  /** Files on disk with no DB row referencing them. */
  orphanFiles: string[];
  checkedRecords: number;
  checkedFiles: number;
}

/**
 * Deterministic storage integrity check (Phase 19 §19.9) — reconciles the
 * two failure modes the storage layer can silently accumulate over time:
 * a DB record whose file was deleted/moved/lost outside the app (missing),
 * and a file left on disk with no DB record pointing at it any more, e.g.
 * from a crash between deleting the DB row and deleting the file
 * (orphaned). Read-only: never deletes or repairs anything itself — an
 * operator decides what to do with the report (re-upload, purge orphans,
 * restore from backup).
 */
export async function checkStorageIntegrity(
  provider: StorageProvider,
  records: Array<{ id: string; key: string }>,
): Promise<StorageIntegrityReport> {
  const knownKeys = new Set(records.map((r) => r.key));

  const missingFiles: Array<{ recordId: string; key: string }> = [];
  for (const record of records) {
    if (!(await provider.exists(record.key))) {
      missingFiles.push({ recordId: record.id, key: record.key });
    }
  }

  const filesOnDisk = await provider.list();
  const orphanFiles = filesOnDisk.filter((key) => !knownKeys.has(key));

  return { missingFiles, orphanFiles, checkedRecords: records.length, checkedFiles: filesOnDisk.length };
}

/** Runs the check against uploaded course documents (`STORAGE_ROOT`). */
export async function checkDocumentStorageIntegrity(): Promise<StorageIntegrityReport> {
  const documents = await prisma.document.findMany({ select: { id: true, storagePath: true } });
  return checkStorageIntegrity(
    storage,
    documents.map((d) => ({ id: d.id, key: d.storagePath })),
  );
}

/** Runs the check against generated Tutor audio (`AUDIO_STORAGE_ROOT`). */
export async function checkAudioStorageIntegrity(): Promise<StorageIntegrityReport> {
  const audio = await prisma.tutorMessageAudio.findMany({ select: { id: true, storageKey: true } });
  return checkStorageIntegrity(
    audioStorage,
    audio.map((a) => ({ id: a.id, key: a.storageKey })),
  );
}
