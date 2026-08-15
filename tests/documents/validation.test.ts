import { describe, expect, it } from "vitest";
import {
  UploadValidationError,
  sanitizeOriginalFilename,
  validatePdfUpload,
} from "@/lib/documents/validation";

function pdfBuffer(content = "fake content"): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(content)]);
}

describe("validatePdfUpload", () => {
  it("accepts a valid PDF", () => {
    expect(() => validatePdfUpload("lecture.pdf", "application/pdf", pdfBuffer())).not.toThrow();
  });

  it("rejects a non-PDF extension", () => {
    expect(() => validatePdfUpload("notes.txt", "text/plain", pdfBuffer())).toThrow(
      UploadValidationError,
    );
  });

  it("rejects a declared mime type other than application/pdf", () => {
    expect(() => validatePdfUpload("notes.pdf", "text/plain", pdfBuffer())).toThrow(
      /Only PDF files/,
    );
  });

  it("rejects a file over the configured size limit", () => {
    const oversized = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(60 * 1024 * 1024, 1)]);
    expect(() => validatePdfUpload("big.pdf", "application/pdf", oversized)).toThrow(/exceeds/);
  });

  it("rejects content whose magic bytes aren't a PDF, even with a .pdf name and PDF mime type", () => {
    const buffer = Buffer.from("this is not a pdf file at all");
    expect(() => validatePdfUpload("fake.pdf", "application/pdf", buffer)).toThrow(
      UploadValidationError,
    );
  });

  it("rejects empty files", () => {
    expect(() => validatePdfUpload("empty.pdf", "application/pdf", Buffer.alloc(0))).toThrow(
      UploadValidationError,
    );
  });
});

describe("sanitizeOriginalFilename", () => {
  it("strips directory components so a path can't escape the storage root", () => {
    expect(sanitizeOriginalFilename("../../etc/passwd.pdf")).toBe("passwd.pdf");
  });

  it("replaces characters that aren't safe for display", () => {
    expect(sanitizeOriginalFilename("weird<>name?.pdf")).toBe("weird__name_.pdf");
  });

  it("falls back to a default name when nothing usable remains", () => {
    expect(sanitizeOriginalFilename("")).toBe("document.pdf");
  });
});
