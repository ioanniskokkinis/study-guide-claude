import { PDFParse } from "pdf-parse";

export interface PdfExtractionResult {
  text: string;
  pageCount: number;
}

/**
 * Raised when a PDF parses successfully but contains no extractable text
 * (e.g. a scanned/image-only page). Distinct from generic extraction
 * failures so callers can show a specific, actionable message instead of a
 * silent empty document.
 */
export class NoExtractableTextError extends Error {
  constructor() {
    super("No extractable text found. OCR is not supported yet.");
    this.name = "NoExtractableTextError";
  }
}

/**
 * Extracts text from a text-based PDF. Does not attempt OCR — an
 * image-only PDF surfaces as `NoExtractableTextError` rather than silently
 * producing an empty document. A future OCR-backed extractor can implement
 * the same `PdfExtractionResult` shape and be swapped in behind this
 * function without changing callers.
 */
export async function extractPdfText(data: Buffer): Promise<PdfExtractionResult> {
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    const pageTexts = result.pages.map((page) => page.text.trim());
    const text = pageTexts.filter((pageText) => pageText.length > 0).join("\n\n");

    if (text.trim().length === 0) {
      throw new NoExtractableTextError();
    }

    return { text, pageCount: result.total };
  } finally {
    await parser.destroy();
  }
}
