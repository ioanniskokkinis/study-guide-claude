import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalStorageProvider } from "@/lib/storage/local-storage";
import { checkStorageIntegrity, checkDocumentStorageIntegrity } from "@/lib/storage/integrity";
import { prisma } from "@/lib/db/prisma";

/**
 * Phase 19 §19.9 — a deterministic storage integrity check. Read-only:
 * verifies it correctly reports both failure modes (a DB record whose file
 * is missing on disk, and a file on disk with no DB record) without ever
 * mutating either side itself.
 */
describe("checkStorageIntegrity", () => {
  let root: string;
  let provider: LocalStorageProvider;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "storage-integrity-"));
    provider = new LocalStorageProvider(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports no findings when every record has a matching file and every file has a matching record", async () => {
    await provider.save("course-1/a.pdf", Buffer.from("a"));
    await provider.save("course-1/b.pdf", Buffer.from("b"));

    const report = await checkStorageIntegrity(provider, [
      { id: "doc-1", key: "course-1/a.pdf" },
      { id: "doc-2", key: "course-1/b.pdf" },
    ]);

    expect(report.missingFiles).toEqual([]);
    expect(report.orphanFiles).toEqual([]);
    expect(report.checkedRecords).toBe(2);
    expect(report.checkedFiles).toBe(2);
  });

  it("detects a DB record whose file is missing on disk", async () => {
    await provider.save("course-1/a.pdf", Buffer.from("a"));
    // doc-2's file was never written (deleted outside the app, lost volume, etc.)

    const report = await checkStorageIntegrity(provider, [
      { id: "doc-1", key: "course-1/a.pdf" },
      { id: "doc-2", key: "course-1/missing.pdf" },
    ]);

    expect(report.missingFiles).toEqual([{ recordId: "doc-2", key: "course-1/missing.pdf" }]);
    expect(report.orphanFiles).toEqual([]);
  });

  it("detects a file on disk with no DB record referencing it", async () => {
    await provider.save("course-1/a.pdf", Buffer.from("a"));
    await provider.save("course-1/orphan.pdf", Buffer.from("o"));

    const report = await checkStorageIntegrity(provider, [{ id: "doc-1", key: "course-1/a.pdf" }]);

    expect(report.missingFiles).toEqual([]);
    expect(report.orphanFiles).toEqual(["course-1/orphan.pdf"]);
  });

  it("never mutates the filesystem or the record list it's given", async () => {
    await provider.save("course-1/a.pdf", Buffer.from("a"));
    await provider.save("course-1/orphan.pdf", Buffer.from("o"));
    const records = [{ id: "doc-1", key: "course-1/a.pdf" }];

    await checkStorageIntegrity(provider, records);

    expect(records).toEqual([{ id: "doc-1", key: "course-1/a.pdf" }]);
    expect(await provider.exists("course-1/a.pdf")).toBe(true);
    expect(await provider.exists("course-1/orphan.pdf")).toBe(true);
  });
});

describe("checkDocumentStorageIntegrity (wired to the real DB + real STORAGE_ROOT)", () => {
  it("finds a document row whose file was never written, without touching the row", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `storage-integrity-${suffix}@example.com` } });
    const course = await prisma.course.create({ data: { userId: user.id, title: `Storage integrity ${suffix}` } });
    const document = await prisma.document.create({
      data: {
        courseId: course.id,
        filename: `f-${suffix}.pdf`,
        originalFilename: `Notes ${suffix}.pdf`,
        mimeType: "application/pdf",
        fileSize: 10,
        type: "pdf",
        storagePath: `integrity-fixture/${suffix}-never-written.pdf`,
        processingStatus: "UPLOADED",
      },
    });

    const report = await checkDocumentStorageIntegrity();
    expect(report.missingFiles.some((m) => m.recordId === document.id)).toBe(true);

    await prisma.user.delete({ where: { id: user.id } });
  });
});
