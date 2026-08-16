import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { createFolder } from "@/lib/services/folders";
import { POST as bulkUpload } from "@/app/api/courses/[id]/documents/bulk/route";
import { makeTextPdfBuffer } from "./fixtures";

/** Phase 15 §2, §6-7, §9(bulk), §13-14 — the bulk multi-file upload API route. */
describe("POST /api/courses/[id]/documents/bulk", () => {
  let courseId: string;

  beforeAll(async () => {
    const user = await getCurrentUser();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    courseId = (await prisma.course.create({ data: { userId: user.id, title: `Bulk Upload Course ${suffix}` } })).id;
  });

  afterAll(async () => {
    await prisma.course.deleteMany({ where: { id: courseId } });
  });

  function buildRequest(files: Array<{ name: string; buffer: Buffer; type: string }>, folderId?: string) {
    const formData = new FormData();
    for (const f of files) {
      formData.append("files", new Blob([new Uint8Array(f.buffer)], { type: f.type }), f.name);
    }
    if (folderId) formData.append("folderId", folderId);
    return new Request(`http://localhost/api/courses/${courseId}/documents/bulk`, { method: "POST", body: formData });
  }

  it("uploads multiple files in one request, each getting its own status", async () => {
    const good1 = await makeTextPdfBuffer("Bulk file one content.");
    const good2 = await makeTextPdfBuffer("Bulk file two content.");
    const request = buildRequest([
      { name: "one.pdf", buffer: good1, type: "application/pdf" },
      { name: "two.pdf", buffer: good2, type: "application/pdf" },
    ]);

    const response = await bulkUpload(request, { params: Promise.resolve({ id: courseId }) });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r: { status: string }) => r.status === "created")).toBe(true);
  });

  it("one failed file does not fail the rest of the batch", async () => {
    const good = await makeTextPdfBuffer("Valid content in a mixed batch.");
    const bad = Buffer.from("not a pdf at all");
    const request = buildRequest([
      { name: "valid.pdf", buffer: good, type: "application/pdf" },
      { name: "invalid.txt", buffer: bad, type: "text/plain" },
    ]);

    const response = await bulkUpload(request, { params: Promise.resolve({ id: courseId }) });
    expect(response.status).toBe(201);
    const body = await response.json();
    const statuses = body.results.map((r: { status: string }) => r.status);
    expect(statuses).toContain("created");
    expect(statuses).toContain("failed");
  });

  it("uploads directly into a specified folder", async () => {
    const user = await getCurrentUser();
    const folder = await createFolder(user.id, courseId, { name: "Bulk target folder" });
    const buffer = await makeTextPdfBuffer("Bulk folder-targeted content.");
    const request = buildRequest([{ name: "foldered.pdf", buffer, type: "application/pdf" }], folder!.id);

    const response = await bulkUpload(request, { params: Promise.resolve({ id: courseId }) });
    const body = await response.json();
    const document = await prisma.document.findUniqueOrThrow({ where: { id: body.results[0].documentId } });
    expect(document.folderId).toBe(folder!.id);
  });

  it("rejects a request with no files", async () => {
    const request = buildRequest([]);
    const response = await bulkUpload(request, { params: Promise.resolve({ id: courseId }) });
    expect(response.status).toBe(400);
  });

  it("returns 404 for a course the requester doesn't own", async () => {
    const otherUser = await prisma.user.create({ data: { email: `bulk-other-${Date.now()}@example.com` } });
    const otherCourse = await prisma.course.create({ data: { userId: otherUser.id, title: "Not yours" } });
    const buffer = await makeTextPdfBuffer("content");
    const request = new Request(`http://localhost/api/courses/${otherCourse.id}/documents/bulk`, {
      method: "POST",
      body: (() => {
        const fd = new FormData();
        fd.append("files", new Blob([new Uint8Array(buffer)], { type: "application/pdf" }), "x.pdf");
        return fd;
      })(),
    });

    const response = await bulkUpload(request, { params: Promise.resolve({ id: otherCourse.id }) });
    expect(response.status).toBe(404);
    await prisma.user.deleteMany({ where: { id: otherUser.id } });
  });
});
