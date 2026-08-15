import path from "node:path";
import { env } from "@/lib/env";

const PDF_MAGIC_BYTES = Buffer.from("%PDF-", "ascii");

export class UploadValidationError extends Error {}

/**
 * Validates an uploaded PDF. Never trusts the client-supplied filename or
 * MIME type alone — the magic-byte check on the actual file contents is
 * the real defense against a spoofed `Content-Type` or a renamed file.
 */
export function validatePdfUpload(
  originalName: string,
  declaredMimeType: string,
  buffer: Buffer,
): void {
  if (buffer.length === 0) {
    throw new UploadValidationError("The uploaded file is empty.");
  }

  const maxBytes = env.MAX_UPLOAD_SIZE_MB * 1024 * 1024;
  if (buffer.length > maxBytes) {
    throw new UploadValidationError(
      `The file exceeds the ${env.MAX_UPLOAD_SIZE_MB} MB upload limit.`,
    );
  }

  const extension = path.extname(originalName).toLowerCase();
  if (extension !== ".pdf") {
    throw new UploadValidationError("Only PDF files are supported.");
  }

  if (declaredMimeType && declaredMimeType !== "application/pdf") {
    throw new UploadValidationError("Only PDF files are supported.");
  }

  if (!buffer.subarray(0, PDF_MAGIC_BYTES.length).equals(PDF_MAGIC_BYTES)) {
    throw new UploadValidationError("The file does not appear to be a valid PDF.");
  }
}

/**
 * Filename shown to the user. Never used to build a storage path — the
 * storage key is always server-generated (see `buildStorageKey`).
 */
export function sanitizeOriginalFilename(name: string): string {
  const base = path.basename(name).trim();
  const cleaned = base.replace(/[^a-zA-Z0-9 ._-]/g, "_").slice(0, 200);
  return cleaned.length > 0 ? cleaned : "document.pdf";
}
